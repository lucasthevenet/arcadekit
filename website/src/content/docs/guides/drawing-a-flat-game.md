---
title: "Drawing a flat game"
description: "A flat game with @arcadekit/three: a camera whose unit is the game's, sprites from a bundle's textures, the pointer as a place of the game, and what is drawn in front."
---

A **flat game** places its entities with `Transform2d`, and `@arcadekit/three` draws them in the x-y plane, with y up. It views that plane through `Three.camera2d`, a camera whose unit is the game's own, draws each kind as sprites of a texture with `Three.sprite`, and turns a click into a place of the plane with `Three.toPlane`. None of it brings Three.js's glTF loader: a flat game imports `Three` alone.

## A top-down game

The rules place a player and crates in a level 64 units wide and 36 high, and aim the player wherever an `Aim` action says. They know nothing about the camera or the pointer.

```ts title="rules.ts"
import {
  Action,
  Commands,
  Component,
  Plugin,
  Query,
  Singleton,
  Field,
  Transform2d,
} from "arcadekit";
import { Effect, Schema } from "effect";

export const Player = Component.tag("game/Player", {
  requires: [Transform2d.Position],
});
export const Crate = Component.tag("game/Crate", {
  requires: [Transform2d.Position],
});
export const level = { left: 0, right: 64, bottom: 0, top: 36 };

export const Aimed = Singleton.define(
  "game/Aimed",
  { angle: Field.f32 },
  { angle: 0 }
);
export const Aim = Action.define(
  "game/Aim",
  Schema.Struct({ x: Schema.Finite, y: Schema.Finite })
);
const Players = Query.all(Transform2d.Position).pipe(Query.with(Player));

export const Rules = Plugin.make("game/Rules", {
  setup: Effect.gen(function* () {
    const commands = yield* Commands.spawns(
      Player,
      Crate,
      Transform2d.Position
    );
    commands.spawn(Player, Transform2d.Position.of({ x: 4, y: 3 }));
    commands.spawn(Crate, Transform2d.Position.of({ x: 9, y: 5 }));
  }),
  handlers: [
    Action.handler(Aim, function* ({ x, y }) {
      const aimed = yield* Aimed.writes;
      const [at] = (yield* Players).single();
      aimed.angle = Math.atan2(y - at.y, x - at.x);
    }),
  ],
});
```

The page draws it. A camera follows the player and stays inside the level, the crates and the player are sprites of the deck's pictures, and an input-stage system turns a click into an `Aim` at the place under the pointer:

```ts title="main.ts"
import { Three } from "@arcadekit/three";
import {
  Action,
  App,
  Assets,
  Driver,
  Input,
  Plugin,
  System,
  Transform2d,
} from "arcadekit";
import { Browser } from "arcadekit/browser";
import { Effect } from "effect";

import { Aim, Crate, Player, Rules, level } from "./rules.ts";

const canvas = document.querySelector("canvas")!;

const Deck = Assets.bundle("game/Deck", {
  hero: Three.texture("/hero.png"),
  crate: Three.texture("/crate.png"),
});

const View = Three.camera2d("game/View", {
  height: 18,
  follow: Player,
  within: level,
});

const Crates = Three.instancesFrom("game/Crates", {
  of: Crate,
  transform: Transform2d,
  from: Deck,
  look: ({ crate }) => Three.sprite(crate),
});
const Heroes = Three.instancesFrom("game/Heroes", {
  of: Player,
  transform: Transform2d,
  from: Deck,
  look: ({ hero }) => Three.sprite(hero, { height: 2 }),
  // In front of the crates.
  prepare: (mesh) => {
    mesh.position.z = 1;
  },
});

const Click = Input.button("game/Click", [Input.pointerButton()]);

const Aiming = System.input("game/Aiming", function* () {
  if ((yield* Click).pressed) {
    const at = yield* Three.toPlane(yield* Input.Pointer);
    (yield* Action.Actions).enqueue(Aim, at);
  }
});

const Look = Plugin.make("game/Look", {
  plugins: [
    Three.plugin,
    Assets.plugin,
    Rules,
    Input.controls("game/Controls", [Click]),
  ],
  systems: [Assets.during(Deck), View, Crates, Heroes, Aiming],
});

Browser.runMain(
  Driver.run(App.define({ plugins: [Look] }), { hz: 60 }).pipe(
    Effect.provide(Three.layerWebGL({ canvas }))
  ),
  { target: canvas }
);
```

The player starts in the level's bottom left corner, and the view stops at the level's edges, so the player is not in the middle of the canvas. The click still aims at the place under it: `Three.toPlane` reads the camera the scene was last drawn with, wherever it was.

## The camera

`Three.camera2d(name, options)` is a frame-stage system that sets `Three.Scene`'s camera to an orthographic one looking straight at the plane, with y up. Its unit is the game's: a view 18 high shows 18 units from the bottom of the canvas to its top, whatever the canvas's size in pixels.

| Option | Default | Description |
| --- | --- | --- |
| `height` | Required | How many units the view shows from bottom to top. Its width follows the canvas's shape. A smaller height zooms in |
| `follow` | None | The component that marks the entity the view is centred on, at its `Transform2d.Position`, or several, all of which it must have |
| `at` | The origin | Where the view is until it finds the entity it follows |
| `within` | None | A rectangle, `{ left, right, bottom, top }`, that the view never shows past. Along a side shorter than the view, the view is centred on it |
| `smooth` | `false` | Whether the view follows the entity between two ticks. It reads `Transform2d.smooth`, the store a kind drawn with `smooth` draws from, so the entity stays put on the canvas. Give it the `smooth` of the kind that draws the entity, or the entity shakes against the view |
| `snap` | None | With `smooth`, the farthest the entity may move in a tick and still be followed between its two positions. Give it the kind's `snap`. A [teleport](transforms.md#teleport-an-entity) counted in `Transform2d.Teleports` needs none |

- The view is fitted each frame to the canvas's size in that frame, so a canvas that changes shape shows more or less of the level across, and never a stretched image. `Three.plugin` asks the renderer for that size at the start of each frame, and `Three.Scene` keeps it as `size`. The renderers of `Three.layerWebGL` and `Three.layerRenderer` give it.
- Its camera, and where it aims while it finds nothing to follow, are a `System.local` of its own, so each app has its own.
- The camera stands 1000 units in front of the plane and draws what is from 1000 in front to 1000 behind it.
- It replaces `Three.Scene`'s camera each frame. A game with a camera of its own leaves it out, and fits its camera itself.

## Sprites

`Three.sprite(texture, { width, height })` makes a look: a quad of the texture, centred on its entity, in a `MeshBasicMaterial` that needs no light and keeps the picture's transparency. Given one side, the other follows the picture's shape, and given none, it is 1 high. `Three.instancesFrom` draws a kind as instances of it, built once each time the bundle loads, so the picture's size is known. An instance's `Color.Rgb` tints it.

A texture that is still loading has no size, and a sprite of it given one side or none throws. Build it in `look`, or give both sides.

## The pointer as a place of the game

The pointer is in CSS pixels from the canvas's top left, with y down. `Three.toPlane(point)` returns the place of the plane z = 0 under a point of the canvas, in the game's units, with y up:

- It reads `Three.Scene`'s camera and `size` as the scene was last rendered, which is what the player saw when they clicked.
- It works through any camera, a perspective one too, through which it is where the line under the pointer crosses the plane.
- Call it in an input-stage system and put the place in the action. A tick can't require `Three.Scene`, so the rules, a replay and the other peers read the place from the log and need no camera.

## What is in front

A flat game's entities are all at z = 0, so what is in front is said per kind, never per entity:

- Give a kind a z of its own: `prepare: (mesh) => { mesh.position.z = 1 }` for instances, or the object's z in `make` for `Three.objects`. A kind at a higher z is drawn in front of one at a lower z, and looks the same size, since the camera has no perspective.
- Sprites are transparent, and Three.js draws transparent meshes from the farthest to the nearest, so the clear pixels of a sprite in front show the kinds behind it.
- Nothing sorts the entities within a kind. Two crates that overlap are drawn in no particular order. Make a kind of each layer that needs one.

## Test it

A test provides a renderer that draws nothing, `Three.makeRecorder(canvas)`, which stands for a canvas of the size it is given. The camera is fitted to it, and `Three.toPlane` reads it. Change `recorder.canvas` to resize it:

```ts sketch
const recorder = Three.makeRecorder({ width: 800, height: 600 });
const made = App.make(game).pipe(Effect.provide(Three.layer(recorder)));
```

Move the pointer with `Input.makeManualSource()`, run `app.input()` and `app.tick(...)`, and read what the action did to the world, as in [testing](testing.md).

## Read more

- [Drawing with Three.js](drawing-with-three.md), for the plugin, the scene and the renderer.
- [Textures and models](textures-and-models.md), for a look built from a bundle.
- [Interpolation](between-two-ticks.md), for `smooth`.
- [`Three`](/reference/three/Three) in the API reference, with [`Camera`](/reference/three/Camera) and [`Sprite`](/reference/three/Sprite).
