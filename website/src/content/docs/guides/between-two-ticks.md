---
title: "Interpolation"
description: "Ticks and frames don't line up. With smooth: true, @arcadekit/three draws each entity between its last two positions, so steady motion looks steady, and Transform2d.smooth does the same for a frame system of your own."
---

**Interpolation** draws each entity between its last two positions, so that steady motion looks steady. A game ticks 60 times a second while a screen shows as many frames as it can, so ticks and frames don't line up. Some frames follow one tick, some two, and some none. An entity drawn where the last tick left it stutters even when it moves at a steady speed. See [ticks and frames](../concepts/ticks-and-frames.md).

With `smooth: true`, `Three.instances` and `Three.objects` interpolate each entity. They draw it `Frame.alpha` of the way from where it was a tick ago to where it is now:

```ts
import { Three } from "@arcadekit/three";
import { Component, Transform3d } from "arcadekit";
import { IcosahedronGeometry, MeshStandardMaterial } from "three";

const Rock = Component.tag("game/Rock", { requires: [Transform3d.Position] });

const Rocks = Three.instances("game/Rocks", {
  of: Rock,
  transform: Transform3d,
  geometry: new IcosahedronGeometry(1),
  material: new MeshStandardMaterial({ color: "#8a8f98" }),
  smooth: true,
});
```

## Decide whether to interpolate

A real-time game wants interpolation. It is off by default because the picture is then up to one tick behind the game.

- Just after a tick, at an `alpha` of 0, an entity is drawn where it was before that tick.
- A game stepped by hand and drawn with `app.frame()`, as a test does, is drawn where its last tick left it, since a frame without an `alpha` is at 1. `app.frame(0)` draws it where it was before that tick.
- A game that ticks when its player moves, run with `ticks: "whenNeeded"`, receives an `alpha` of 1 while it rests, so it is drawn where it is.

## Predict where an entity is drawn

- Positions and scales are interpolated linearly. Rotations take the shorter path. A quaternion turns towards whichever of the target and its negation is closer, and a flat game's angle turns the shorter way round.
- An entity not drawn in the previous frame is drawn where it is. That includes a new entity, one that reuses another's slot, one that was hidden, and every entity in the first frame, after a load, or after a frame in which no system drew it.
- An entity that teleported, whose `Teleports` count changed since the previous frame, is drawn where it is until the next tick moves it on, by every reader alike. See [teleport an entity](transforms.md#teleport-an-entity).
- `snap` is how far an entity can move in one tick and still be interpolated, in scene units, one distance per kind, for a long move the game doesn't count as a teleport. An entity that moved further is drawn where it is. Without `snap`, any distance counts as motion.
- When several ticks ran since the last frame, an entity starts from where it was last drawn, more than a tick back, so it moves faster for that one frame. When no tick ran, it stays between the same two positions as in the previous frame.
- A position changed without a tick, by an action dispatched between ticks, becomes the target, and the entity moves to it from where it was coming from.
- An [instance's colour](instances-and-objects.md#colour-each-instance) is interpolated too, however far it changes.

## Check what interpolation stores and costs

The app stores the previous value of each component per entity, outside the world, from the first frame that draws the entity smoothly. A game that draws nothing smoothly stores nothing. A game drawn this way has the same hash, log, and save as one that isn't drawn at all.

Interpolation costs about 17 ns more per entity per frame for a position, and 54 ns more for a position, a rotation, and a scale.

## Interpolate in your own frame system

A frame system of your own, such as one that draws on a canvas or moves a camera, interpolates with `Transform2d.smooth` or `Transform3d.smooth`:

```ts
import { Component, Query, System, Transform2d } from "arcadekit";

const Player = Component.tag("game/Player", {
  requires: [Transform2d.Position],
});
const Players = Query.all(Transform2d.Position).pipe(Query.with(Player));

const context = document.querySelector("canvas")!.getContext("2d")!;

const Draw = System.frame("game/Draw", function* () {
  const smooth = yield* Transform2d.smooth;
  (yield* Players).each((position, entity) => {
    const at = smooth.position(entity, position);
    context.fillRect(at.x, at.y, 8, 8);
  });
});
```

- `smooth.position`, `smooth.rotation` and `smooth.scale` take an entity and its component as the query hands it, and return where, at what angle and at what size it is drawn. `snap`, the third argument of `position`, works as the option of the same name.
- `smooth.positions`, `smooth.rotations` and `smooth.scales` do the same for a run of rows that `eachChunk` hands out, into columns of the app's own that the next call overwrites, and allocate nothing per entity.
- `Color.smooth` gives `color` and `colors`, which blend an entity's `Color.Rgb` however far it changed.
- The rules above hold for it: an entity read in the previous frame comes from where it was, and every other one is drawn where it is.
- It reads the same store as `Three.instances` and `Three.objects`. A camera that follows an entity drawn with `smooth: true` stays on it between ticks, and an entity one system read in the previous frame comes from where it was for every system.
- It requires `Frame`, so a system of the tick or the input stage that asks for it doesn't compile.

The game keeps no previous position of its own for this, and nothing of it is in the world.

## Read more

- [Instances and objects](instances-and-objects.md), which accept `smooth` and `snap`.
- [`Three`](/reference/three/Three) in the API reference.
