---
title: "Drawing with Three.js"
description: "arcadekit draws nothing itself. @arcadekit/three is a plugin, in its own package, that renders your game with Three.js."
---

**[`@arcadekit/three`](/reference/three)** is the plugin, in a package of its own, that draws a game with [Three.js](https://threejs.org). arcadekit draws nothing itself. A game that draws with something else leaves this plugin out, and the game's rules can't tell whether it is there. The plugin runs in the frame stage, between ticks, and reads the world without changing it. A drawn game has the same hash, log, and save as one that isn't drawn.

```sh
pnpm add arcadekit @arcadekit/three effect three
```

`arcadekit`, `effect`, and `three` are peer dependencies. Your game has one copy of each, so arcadekit's components and services are the same objects in the plugin as in your game.

## Place entities in the rules, draw them in the page

Your rules place entities with arcadekit's own `Transform3d` or `Transform2d`, and colour an instance with arcadekit's `Color`. `@arcadekit/three` has no components of its own. It only reads these, and reads each kind of entity from the transform the kind names. The plugins that hold your rules import nothing from it, so a server or a replay installs neither it nor Three.js.

```ts title="rules.ts"
import { Commands, Component, Plugin, Transform3d } from "arcadekit";
import { Effect } from "effect";

export const Rock = Component.tag("game/Rock");

export const Rules = Plugin.make("game/Rules", {
  setup: Effect.gen(function* () {
    const commands = yield* Commands.spawns(
      Rock,
      Transform3d.Position,
      Transform3d.Rotation,
      Transform3d.Scale
    );
    commands.spawn(Rock, Transform3d.Position.of({ x: 0, y: 4, z: 0 }));
    commands.spawn(
      Rock,
      Transform3d.Position.of({ x: 3, y: 4, z: 0 }),
      Transform3d.Rotation.of(Transform3d.axisAngle(0, 0, 1, Math.PI / 2)),
      Transform3d.Scale.of({ x: 2, y: 2, z: 2 })
    );
  }),
});
```

Only the page's code imports `@arcadekit/three`: the plugin that says how each kind of entity looks, and the module that starts the game and provides a renderer.

```ts title="main.ts"
import { Three } from "@arcadekit/three";
import { App, Driver, Plugin, Transform3d } from "arcadekit";
import { Browser } from "arcadekit/browser";
import { Effect, Layer } from "effect";
import { AmbientLight, IcosahedronGeometry, MeshStandardMaterial } from "three";

import { Rock, Rules } from "./rules";

const canvas = document.querySelector("canvas")!;

const Rocks = Three.instances("game/Rocks", {
  of: Rock,
  transform: Transform3d,
  geometry: new IcosahedronGeometry(1),
  material: new MeshStandardMaterial({ color: "#8a8f98" }),
});

const Look = Plugin.make("game/Look", {
  plugins: [Three.plugin, Rules],
  // Once, when the app is created: lights, and where the camera stands.
  layer: Layer.effectDiscard(
    Effect.map(Three.Scene, ({ scene, camera }) => {
      scene.add(new AmbientLight("#ffffff", 1));
      camera.position.set(0, 10, 20);
      camera.lookAt(0, 0, 0);
    })
  ),
  systems: [Rocks],
});

Browser.runMain(
  Driver.run(App.define({ plugins: [Look] }), { hz: 60 }).pipe(
    Effect.provide(Three.layerWebGL({ canvas }))
  ),
  { target: canvas }
);
```

A frame-stage system of one of two types draws each kind of entity:

- `Three.instances` draws every entity of a kind as an instance of one mesh. Use it for crowds.
- `Three.objects` keeps one `Object3D` per entity, for the few entities that are more than a copy of one mesh.

[Instances and objects](instances-and-objects.md) covers both. [Textures and models](textures-and-models.md) covers looks built from a level's files, and [interpolation](between-two-ticks.md) covers smooth motion at any refresh rate.

## Choose an entry point

| Entry | Contents | Imports |
| --- | --- | --- |
| `@arcadekit/three` | Both modules below, as `import { Gltf, Three } from "@arcadekit/three"` | `arcadekit`, `effect`, `three` |
| `@arcadekit/three/Three` | The plugin, the scene, the renderer, `instances`, `objects`, and `texture` | `arcadekit`, `effect`, `three` |
| `@arcadekit/three/Gltf` | `model`, the glTF asset, and `mesh` | `arcadekit`, `effect`, `three`, and Three.js's glTF loader from `three/addons` |

Models have their own module because they bring Three.js's glTF loader, which a game without models doesn't need to ship. Nothing in `Three` imports the loader.

## Place, rotate, and scale an entity

Each kind names the module that places its entities, as `transform: Transform3d` does above, and reads no other. A kind of `Transform3d` draws an entity at its `Transform3d.Position`, in scene units.

- `Transform3d.Rotation` is a quaternion, and `Transform3d.Scale` is 1 at the geometry's own size. Give them to entities that rotate or have a size of their own. An entity without them is drawn upright at the geometry's size, and costs less to draw.
- A `Rotation` is drawn as the rotation it represents, whatever its length. A rotation that your rules let drift from length 1, or never normalised, neither skews nor scales the entity. Normalising costs about 3 ns per instance, one division.
- A `Rotation` whose four fields are 0, as one added without a value is, draws as no rotation.

## Draw a flat game

A flat game places its entities with `Transform2d`, and a kind that names it draws them the same way.

```ts sketch
commands.spawn(
  Card,
  Transform2d.Position.of({ x: 120, y: 80 }),
  Transform2d.Rotation.of({ angle: Math.PI / 6 })
);

const Cards = Three.instances("game/Cards", {
  of: Card,
  transform: Transform2d,
  geometry,
  material,
});
```

- A kind of `Transform2d` draws an entity at its `Transform2d.Position`, in the x-y plane at z = 0. It rotates the entity about the z axis by its `Transform2d.Rotation`, and scales it along x and y by its `Transform2d.Scale`.
- Set the draw order per kind, not per entity. For instances, use `prepare: (mesh) => { mesh.position.z = 1 }`. For objects, place the object in `make`. Nothing sorts entities within a kind.
- To show the plane flat, set the `camera` of `Three.Scene` to an `OrthographicCamera`.
- A game can draw flat and 3D entities side by side, with a kind for each. A kind reads nothing of the other module. An entity with both positions is drawn by a kind of each, from that kind's own position.

## Set up the scene, the camera, and the renderer

`Three.plugin` gives an app a scene and draws it once per frame. Set up lights once in a plugin's layer, as `Look` does above. Move the camera every frame in a frame system of your own:

```ts
import { Three } from "@arcadekit/three";
import { Field, Singleton, System } from "arcadekit";

const Player = Singleton.define("game/Player", { x: Field.f32 }, { x: 0 });

// Each frame, before the scene is rendered.
const Follow = System.frame("game/Follow", function* () {
  const { camera } = yield* Three.Scene;
  camera.position.x = (yield* Player).x;
});
```

- `Three.Scene` is the service. It holds `scene`, a Three.js `Scene`, and `camera`, a perspective camera at (0, 0, 10) until you move or replace it. You can assign `camera`, for example to an `OrthographicCamera`. The service belongs to drawing, not to the game. No tick reads it, and none of it is saved.
- `Three.Render` is the system that draws the scene. It runs in `"postFrame"`, so every frame-stage system has run before it, wherever each is listed and with no order declared. Those systems include `Three.instances`, `Three.objects`, and your own frame systems that move the camera or anything else.
- `Three.Renderer` draws the scene, and comes from outside the app, because it needs a canvas. A game that installs `Three.plugin` without providing a renderer doesn't compile.
- `Three.layerWebGL({ canvas, antialias: true })` provides a `WebGLRenderer` for a page, with the parameters Three.js accepts. `Three.layerRenderer(() => new WebGPURenderer({ canvas }))` provides a renderer that you create yourself, ready to draw. Initialise a `WebGPURenderer` before you provide it.
- Each layer disposes of its renderer when the scope it is provided to closes. Provide it to the whole program, as the example above does with `Driver.run`.

Both layers take these options:

| Option | Default | Description |
| --- | --- | --- |
| `fit` | `true` | Whether the image follows the canvas's size on the page. When the size changes, the layer resizes the renderer without touching the canvas's style, and gives a perspective camera the new aspect ratio |
| `pixelRatio` | The page's `devicePixelRatio`, capped at 2 | How many pixels are drawn per CSS pixel |

A layer fits only a perspective camera. Fit any other kind of camera yourself when the canvas's size changes.

## Test without a canvas

A test provides a renderer that draws nothing, `Layer.succeed(Three.Renderer, { render(scene, camera) {} })`. Three.js builds scenes and meshes under Node as it does in a page, so you can inspect what was added to the scene. See [testing](testing.md).

## Write a plugin for another renderer

Frame-stage systems draw a game, in a plugin that only the page installs. A plugin of your own for another renderer keeps to the same rules as this one:

- It decides what to draw from the components an entity has, and where to draw it from `Transform3d` or `Transform2d`, whichever the kind names. The rules say what an entity is, never how it looks.
- It draws crowds from raw columns into one buffer, and allocates nothing per entity per frame.
- It keeps state across frames, such as a mesh, a scene, or where an entity was a tick ago, in a service. The plugin's `layer` builds the service, and closing the app releases it. That state is never in the world.
- What it draws to, a renderer or a canvas, comes from outside, as a service the game provides.

## Find a service or system by name

- The services are named `"arcadekit/three/Scene"` and `"arcadekit/three/Renderer"`.
- The plugin is `"arcadekit/three"`, and the system that draws the scene is `"arcadekit/three/Render"`.
- A system made by `Three.instances` or `Three.objects` has the name you give it, which is also its mesh's name. The name must be unique among the app's systems.

## Read more

- [Instances and objects](instances-and-objects.md), [textures and models](textures-and-models.md), [interpolation](between-two-ticks.md), and [drawing performance](drawing-performance.md).
- [`@arcadekit/three`](/reference/three) in the API reference, with [`Three`](/reference/three/Three) and [`Gltf`](/reference/three/Gltf).
- [`packages/three/examples/page`](../../../../../packages/three/examples/page): ten thousand moving objects, run with `pnpm --filter @arcadekit/three page`.
