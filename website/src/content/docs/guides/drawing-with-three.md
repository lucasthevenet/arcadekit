---
title: "Drawing with Three.js"
description: "arcadekit draws nothing itself. @arcadekit/three is a plugin, in its own package, that renders your game with Three.js."
---

arcadekit draws nothing itself. [`@arcadekit/three`](/reference/three) is a plugin, published as its own package, that renders your game with [Three.js](https://threejs.org). A game that renders with something else leaves it out, and the game itself doesn't know whether it is there. It runs in the frame stage, between ticks, and reads the world without changing it, so a rendered game has the same hash, log and save as one that isn't rendered.

```sh
pnpm add arcadekit @arcadekit/three effect three
```

`arcadekit`, `effect` and `three` are peer dependencies: your game has one copy of each, so arcadekit's components and services are the same objects here as in your game.

## Rules decide where, the page decides how

Your rules place entities with arcadekit's own `Transform3d` or `Transform2d`. `@arcadekit/three` has no components of its own and only reads these. The plugins that hold your rules import nothing from it, so a server or a replay installs neither it nor Three.js.

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

Only page code imports `@arcadekit/three`: the plugin that defines how each kind of entity looks, and the module that starts the game and provides a renderer.

```ts title="main.ts"
import { Three } from "@arcadekit/three";
import { App, Driver, Plugin } from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Effect, Layer } from "effect";
import { AmbientLight, IcosahedronGeometry, MeshStandardMaterial } from "three";

import { Rock, Rules } from "./rules";

const canvas = document.querySelector("canvas")!;

const Rocks = Three.instances("game/Rocks", {
  of: Rock,
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
  Driver.run(App.make(App.define({ plugins: [Look] })), { hz: 60 }).pipe(
    Effect.provide(Three.layerWebGL({ canvas }))
  ),
  { target: canvas }
);
```

Each kind of entity is drawn by a frame-stage system of one of two types:

- `Three.instances` draws every entity of a kind as an instance of one mesh. Use it for crowds.
- `Three.objects` keeps one `Object3D` per entity, for the few entities that are more than a copy of one mesh.

[Instances and objects](instances-and-objects.md) covers both. Looks built from a level's files are covered in [textures and models](textures-and-models.md), and smooth motion at any screen refresh rate in [interpolation](between-two-ticks.md).

## Entry points

| Entry | Contents | Imports |
| --- | --- | --- |
| `@arcadekit/three` | Both modules below, as `import { Gltf, Three } from "@arcadekit/three"` | `arcadekit`, `effect`, `three` |
| `@arcadekit/three/Three` | The plugin, the scene, the renderer, `instances`, `objects` and `texture` | `arcadekit`, `effect`, `three` |
| `@arcadekit/three/Gltf` | `model`, the glTF asset, and `mesh` | `arcadekit`, `effect`, `three`, and Three.js's glTF loader from `three/addons` |

Models have their own module because they bring Three.js's glTF loader with them, which a game without models doesn't need to ship. Nothing in `Three` imports it.

## Position, rotation and scale

An entity is drawn at its `Transform3d.Position`, in scene units.

- `Transform3d.Rotation`, a quaternion, and `Transform3d.Scale`, where 1 is the geometry's own size, are for entities that rotate or have a size of their own. An entity without them is drawn upright at the geometry's size, and costs less to draw.
- A `Rotation` is drawn as the rotation it represents, whatever its length: one your rules let drift from length 1, or never normalised, is neither skewed nor scaled by it. Normalising costs an instance about 3 ns, one division.
- A `Rotation` whose four fields are 0, which is what one added without a value is, is drawn as no rotation.

## Flat games

A flat game places its entities with `Transform2d`, and the same systems draw them the same way.

```ts sketch
commands.spawn(
  Card,
  Transform2d.Position.of({ x: 120, y: 80 }),
  Transform2d.Rotation.of({ angle: Math.PI / 6 })
);
```

- An entity with a `Transform2d.Position` is drawn in the x–y plane at 0 on the third axis, rotated about that axis by its `Transform2d.Rotation`, and scaled along x and y by its `Transform2d.Scale`.
- Draw order is set per kind, not per entity: `prepare: (mesh) => { mesh.position.z = 1 }` for instances, and wherever `make` places an object for objects. Nothing sorts entities within a kind.
- An orthographic camera shows the plane flat: set the `camera` of `Three.Scene` to an `OrthographicCamera`.
- A game can mix flat and 3D entities, even within one kind. An entity with both positions is drawn once, from the 3D one, and its `Transform2d` rotation and scale are ignored.

## Scene, camera and renderer

`Three.plugin` gives an app a scene and renders it once per frame. A plugin's layer sets up lights once, as `Look` does above. A frame system of your own moves the camera every frame:

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

- `Three.Scene` is the service: `scene`, a Three.js `Scene`, and `camera`, a perspective camera at (0, 0, 10) until you move or replace it; `camera` is assignable, to an `OrthographicCamera` for example. It belongs to rendering, not to the game: no tick reads it, and none of it is saved.
- `Three.Render` is the system that renders. It runs in `"postFrame"`, so every frame-stage system has run before it, wherever each is listed and with no ordering needed: `Three.instances`, `Three.objects`, and your own frame systems that move the camera or anything else.
- `Three.Renderer` draws the scene, and comes from outside the app, since it needs a canvas. A game that installs `Three.plugin` without providing one doesn't compile.
- `Three.layerWebGL({ canvas, antialias: true })` provides a `WebGLRenderer` for a page, with the parameters Three.js accepts. `Three.layerRenderer(() => new WebGPURenderer({ canvas }))` provides a renderer you create yourself, ready to draw: initialise a `WebGPURenderer` before providing it. Either is disposed when the scope it is provided to closes, so provide it to the whole program, as `Driver.run` is above.
- The output follows the canvas's size on the page: when it changes, the renderer is resized without touching the canvas's style, and a perspective camera gets the new aspect ratio. `fit: false` turns this off, and you are responsible for fitting other camera types. `pixelRatio` defaults to the page's own, capped at 2.

## In a test

A test provides a renderer that draws nothing, `Layer.succeed(Three.Renderer, { render(scene, camera) {} })`. Three.js builds scenes and meshes under Node as it does in a page, so you can inspect what was added to the scene. See [testing](testing.md).

## Writing your own renderer

A game is drawn by frame-stage systems, in a plugin that only the page installs. A plugin of your own for another renderer follows the same principles as this one:

- It decides what to draw from the components an entity has, and where from `Transform3d.Position` or `Transform2d.Position`. The rules say what an entity is, never how it looks.
- It draws crowds from raw columns into one buffer, allocating nothing per entity per frame.
- It keeps state across frames, such as a mesh, a scene, or where an entity was a tick ago, in a service built in the plugin's `layer` and released with the app's scope, never in the world.
- Its output target, a renderer or a canvas, comes from outside, as a service the game provides.

## Names

- The services are named `"arcadekit/three/Scene"` and `"arcadekit/three/Renderer"`.
- The plugin is `"arcadekit/three"`, and the rendering system `"arcadekit/three/Render"`.
- A system created by `Three.instances` or `Three.objects` has the name you give it, which is also its mesh's name.

## Read more

- [Instances and objects](instances-and-objects.md), [textures and models](textures-and-models.md) and [interpolation](between-two-ticks.md).
- [`@arcadekit/three`](/reference/three) in the API reference, with [`Three`](/reference/three/Three) and [`Gltf`](/reference/three/Gltf).
- [`packages/three/examples/page`](../../../../../packages/three/examples/page): ten thousand moving objects, run with `pnpm --filter @arcadekit/three page`.
