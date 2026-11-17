# Drawing with Three.js

arcadekit draws nothing itself. [`@arcadekit/three`](../../packages/three/README.md) is a plugin, in a package of its own, that draws a game with [Three.js](https://threejs.org). It runs in the frame stage and reads the world without changing it, so a game that is drawn has the same hash, log and save as one that is not.

```sh
pnpm add arcadekit @arcadekit/three effect three
```

## The rules say where, the page says how

The rules place things with arcadekit's own `Transform3d` or `Transform2d`. They import nothing of `@arcadekit/three`, so a server and a replay install neither it nor Three.js.

```ts title="rules.ts"
import { Commands, Component, Plugin, Transform3d } from "arcadekit";
import { Effect } from "effect";

export const Rock = Component.tag("game/Rock");

export const Rules = Plugin.make("game/Rules", {
  plugins: [Transform3d.plugin],
  components: [Rock],
  setup: Effect.gen(function* () {
    (yield* Commands).spawn(
      Rock,
      Transform3d.Position.of({ x: 0, y: 4, z: 0 })
    );
  }),
});
```

The page says how each kind of thing looks, and provides a renderer:

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
  smooth: true,
});

const Look = Plugin.make("game/Look", {
  plugins: [Three.plugin, Rules],
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

## Instances

`Three.instances` draws every entity of a kind as one instance of one mesh. An entity is one of them while it has every component `of` names, none of `without`, and a position.

Each frame it reads the columns raw and writes one matrix per entity into the mesh's buffer, with nothing allocated per entity. Ten thousand moving objects cost 0.1 to 0.4 ms of a frame before Three.js takes over.

- `color` names a component of the game's with fields `r`, `g` and `b`, which gives each instance a colour.
- `from` and `look` make the geometry and material of a level's assets, while the bundle is loaded. `Three.texture(url)` is a texture asset, and `Gltf.model(url)`, from `@arcadekit/three/Gltf`, a glTF model.
- `smooth: true` draws each entity between its last two places, at `Frame.alpha` of the way, so a game whose ticks and frames don't line up moves evenly. The picture is then up to one tick behind the game.
- The geometry and material are the game's to dispose of.

## Objects

`Three.objects` keeps one `Object3D` per entity, for the few things that are more than a copy of one mesh: a model with parts, a light. `make` is called the first frame an entity is one of the kind, and `free` when it no longer is. Each frame every object is given its entity's place.

## The scene and the camera

`Three.Scene` is a service with the `scene` and the `camera`. A plugin's layer sets up lights once, as above. A frame system of the game's moves the camera each frame. The scene is drawn in `"postFrame"`, after every system of the frame, wherever each is listed.

`Three.layerWebGL({ canvas })` is a page's renderer. `Three.layerRenderer(make)` takes one of your own, a `WebGPURenderer` for instance. A test provides one that draws nothing, `Layer.succeed(Three.Renderer, { render() {} })`, and looks at what was put in the scene.

## A flat game

A flat game places things with `Transform2d`, and the same systems draw them in the plane of x and y. An orthographic camera sees the plane flat: set the `camera` of `Three.Scene` to an `OrthographicCamera`.

## Read more

- [The `@arcadekit/three` reference](../../packages/three/README.md), with colours, textures, models, the benchmark, and what is not done yet.
- [`packages/three/examples/page`](../../packages/three/examples/page): ten thousand moving objects.
