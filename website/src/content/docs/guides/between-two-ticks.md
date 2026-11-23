---
title: "Interpolation"
description: "Ticks and frames don't line up. With smooth: true, @arcadekit/three draws each entity between its last two positions, so steady motion looks steady."
---

**Interpolation** draws each entity between its last two positions, so that steady motion looks steady. A game ticks 60 times a second while a screen shows as many frames as it can, so ticks and frames don't line up. Some frames follow one tick, some two, and some none. An entity drawn where the last tick left it stutters even when it moves at a steady speed. See [ticks and frames](../concepts/ticks-and-frames.md).

With `smooth: true`, `Three.instances` and `Three.objects` interpolate each entity. They draw it `Frame.alpha` of the way from where it was a tick ago to where it is now:

```ts
import { Three } from "@arcadekit/three";
import { Component, Transform3d } from "arcadekit";
import { IcosahedronGeometry, MeshStandardMaterial } from "three";

const Rock = Component.tag("game/Rock");

const Rocks = Three.instances("game/Rocks", {
  of: Rock,
  transform: Transform3d,
  geometry: new IcosahedronGeometry(1),
  material: new MeshStandardMaterial({ color: "#8a8f98" }),
  smooth: true,
  snap: 50, // moving further than this in one tick is a jump, not motion
});
```

## Decide whether to interpolate

A real-time game wants interpolation. It is off by default because the picture is then up to one tick behind the game.

- Just after a tick, at an `alpha` of 0, an entity is drawn where it was before that tick.
- A game stepped by hand and drawn with `app.frame(0)`, as a test does, shows each tick's result only after the next tick.
- A game that ticks when its player moves, run with `ticks: "whenNeeded"`, receives an `alpha` of 1 while it rests, so it is drawn where it is.

## Predict where an entity is drawn

- Positions and scales are interpolated linearly. Rotations take the shorter path. A quaternion turns towards whichever of the target and its negation is closer, and a flat game's angle turns the shorter way round.
- An entity not drawn in the previous frame is drawn where it is. That includes a new entity, one that reuses another's slot, one that was hidden, and every entity in the first frame, after a load, or after a frame in which the system didn't run.
- `snap` is how far an entity can move in one tick and still be interpolated, in scene units, one distance per kind. An entity that moved further, such as one that wrapped from one edge of the world to the other, is drawn where it is. Without `snap`, any distance counts as motion.
- When several ticks ran since the last frame, an entity starts from where it was last drawn, more than a tick back, so it moves faster for that one frame. When no tick ran, it stays between the same two positions as in the previous frame.
- A position changed without a tick, by an action dispatched between ticks, becomes the target, and the entity moves to it from where it was coming from.
- An [instance's colour](instances-and-objects.md#colour-each-instance) is interpolated too, however far it changes.

## Check what interpolation stores and costs

The system stores the previous value of each component per entity, outside the world. A game drawn this way has the same hash, log, and save as one that isn't drawn at all.

Interpolation costs about 18 ns more per entity per frame for a position, and 63 ns more for a position, a rotation, and a scale.

## Interpolate in your own frame system

To interpolate in a frame system of your own, compute the position at `(yield* Frame).alpha` from a velocity or a previous position that your simulation keeps, as the frame example in [ticks and frames](../concepts/ticks-and-frames.md#drawing-never-changes-the-game) does.

## Read more

- [Instances and objects](instances-and-objects.md), which accept `smooth` and `snap`.
- [`Three`](/reference/three/Three) in the API reference.
