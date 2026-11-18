---
title: "Drawing with Three.js"
description: "arcadekit draws nothing itself. @arcadekit/three is a plugin, in a package of its own, that draws a game with Three.js."
---

arcadekit draws nothing itself. [`@arcadekit/three`](/reference/three) is a plugin, in a package of its own, that draws a game with [Three.js](https://threejs.org). A game that draws with something else leaves it out, and the game it draws does not know it is there. It runs in the frame stage, between ticks, and reads the world without changing it, so a game that is drawn has the same hash, log and save as one that is not.

```sh
pnpm add arcadekit @arcadekit/three effect three
```

`arcadekit`, `effect` and `three` are peer dependencies: a game has one copy of each, so a component or a service of arcadekit's is the same object here as in the game.

## The rules say where, the page says how

The rules place things with arcadekit's own `Transform3d` or `Transform2d`. `@arcadekit/three` has no components of its own, and only reads them. The plugins that hold the rules import nothing of it, so a server and a replay install neither it nor Three.js.

```ts title="rules.ts"
import { Commands, Component, Plugin, Transform3d } from "arcadekit";
import { Effect } from "effect";

export const Rock = Component.tag("game/Rock");

export const Rules = Plugin.make("game/Rules", {
  plugins: [Transform3d.plugin],
  components: [Rock],
  setup: Effect.gen(function* () {
    const commands = yield* Commands;
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

Only what belongs to the page imports `@arcadekit/three`: the plugin that says how each kind of thing looks, and the module that starts the game and provides a renderer.

```ts title="main.ts"
import { Three } from "@arcadekit/three";
import { App, Plugin } from "arcadekit";
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
  // Once, when the app is made: lights, and where the camera stands.
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
  App.run({ plugins: [Look] }, { hz: 60 }).pipe(
    Effect.provide(Three.layerWebGL({ canvas }))
  ),
  { target: canvas }
);
```

What draws a kind of thing is a system of the frame stage, of one of two sorts:

- `Three.instances` draws every entity of a kind as one instance of one mesh. It is for a crowd.
- `Three.objects` keeps one `Object3D` per entity, for the few things that are more than a copy of one mesh.

[Instances and objects](instances-and-objects.md) covers both. A look made of a level's files is in [textures and models](textures-and-models.md), and drawing a thing that moves evenly, whatever the screen's rate, in [between two ticks](between-two-ticks.md).

## What to import

| Entry | What it has | Imports |
| --- | --- | --- |
| `@arcadekit/three` | The two modules below, as `import { Gltf, Three } from "@arcadekit/three"` | `arcadekit`, `effect`, `three` |
| `@arcadekit/three/Three` | The plugin, the scene, the renderer, `instances`, `objects` and `texture` | `arcadekit`, `effect`, `three` |
| `@arcadekit/three/Gltf` | `model`, the asset that is a glTF file, and `mesh` | `arcadekit`, `effect`, `three`, and its glTF loader, `three/addons` |

Models are a module of their own because they bring the glTF loader of Three.js with them, which a game with no models need not carry. Nothing in `Three` imports it.

## Where a thing is

An entity is drawn where its `Transform3d.Position` says, in the units of the scene.

- `Transform3d.Rotation`, a quaternion, and `Transform3d.Scale`, where 1 is the size of the geometry, are for the entities that turn or have a size of their own. One without them is drawn upright, at the size of its geometry, and costs less to draw.
- A `Rotation` is drawn as the turn it stands for, whatever its length: one that the game's rules let drift from length 1, or never made of it, is neither skewed nor sized by that. It costs an instance about 3 ns, one division.
- A `Rotation` whose four fields are 0, which is what one added with no value is, is drawn as not turned.
- `Three.plugin` depends on `Transform3d.plugin` and on `Transform2d.plugin`, which list the components.

## A flat game

A flat game places its things with `Transform2d`, and is drawn the same way by the same systems.

```ts sketch
commands.spawn(
  Card,
  Transform2d.Position.of({ x: 120, y: 80 }),
  Transform2d.Rotation.of({ angle: Math.PI / 6 })
);
```

- An entity with a `Transform2d.Position` is drawn in the plane of x and y, at 0 of the third axis, turned about that axis by its `Transform2d.Rotation` and sized along x and y by its `Transform2d.Scale`.
- What is in front of what is the kind's to say, not the entity's: `prepare: (mesh) => { mesh.position.z = 1 }` for instances, and where `make` puts an object for objects.
- An orthographic camera sees the plane flat: set the `camera` of `Three.Scene` to an `OrthographicCamera`.
- A game can have things of both kinds, and one kind can hold both. An entity with both positions is drawn once, from the one of three dimensions; its `Transform2d` rotation and scale are then not read.

## The scene, the camera and the renderer

`Three.plugin` gives an app a scene and draws it once per frame. A plugin's layer sets up lights once, as `Look` does above. A frame system of the game's moves the camera each frame:

```ts
import { Three } from "@arcadekit/three";
import { Field, Singleton, System } from "arcadekit";

const Player = Singleton.define("game/Player", { x: Field.f32 }, { x: 0 });

// Each frame, before the scene is drawn.
const Follow = System.make("game/Follow", function* () {
  const { camera } = yield* Three.Scene;
  camera.position.x = (yield* Player).x;
}).pipe(System.inStage("frame"));
```

- `Three.Scene` is the service: `scene`, a Three.js `Scene`, and `camera`, a perspective camera at (0, 0, 10) until it is moved or replaced: `camera` can be assigned, an `OrthographicCamera` for one. It is what draws the game and not the game: nothing in a tick reads it, and none of it is saved.
- `Three.Render` is the system that draws. It is of the stage after a frame's own, `"postFrame"`, so every system of the frame stage has run when it does, wherever each is listed and with nothing said: `Three.instances` and `Three.objects`, and a frame system of the game's that moves the camera or anything else.
- `Three.Renderer` is what draws the scene, and comes from outside the app, since it needs a canvas. A game that installs `Three.plugin` and provides none does not compile.
- `Three.layerWebGL({ canvas, antialias: true })` is a page's: a `WebGLRenderer` with the parameters Three.js takes. `Three.layerRenderer(() => new WebGPURenderer({ canvas }))` is one of your own making. Either is disposed of when the scope it is provided to closes, so it is provided to the whole program, as `App.run` is above.
- The picture follows the size the canvas has on the page: when that changes the renderer is resized, without touching the canvas's style, and a perspective camera is given the new aspect. `fit: false` leaves it alone, and a camera of another kind is the game's to fit. `pixelRatio` is the page's own, up to 2, unless given.

## In a test

A test provides a renderer that draws nothing, `Layer.succeed(Three.Renderer, { render(scene, camera) {} })`. Three.js makes its scenes and meshes under Node as in a page, so what was put in the scene can be looked at. See [testing](testing.md).

## Drawing with something else

What draws a game is systems of the frame stage, in a plugin that only the page installs. One of your own, for another renderer, keeps to what this one does:

- It tells what to draw from the components an entity has, and where from `Transform3d.Position` or `Transform2d.Position`. The rules say what a thing is, never how it looks.
- A crowd is drawn from raw columns into one buffer, with nothing made per entity per frame.
- What it keeps from one frame to the next, a mesh, a scene, where a thing was a tick ago, is in a service, made in the plugin's `layer` and let go with the app's scope, and never in the world.
- What it draws through, a renderer or a canvas, comes from outside, as a service the game provides.

## Names

- The services are keyed `"arcadekit/three/Scene"` and `"arcadekit/three/Renderer"`.
- The plugin is `"arcadekit/three"`, and the system that draws `"arcadekit/three/Render"`.
- A system made by `Three.instances` or `Three.objects` has the name it was given, which is one of the app's systems' and is the name of the mesh.

## Read more

- [Instances and objects](instances-and-objects.md), [textures and models](textures-and-models.md) and [between two ticks](between-two-ticks.md).
- [`@arcadekit/three`](/reference/three) in the API reference, with [`Three`](/reference/three/Three) and [`Gltf`](/reference/three/Gltf).
- [`packages/three/examples/page`](../../../../../packages/three/examples/page): ten thousand moving objects, run with `pnpm --filter @arcadekit/three page`.
