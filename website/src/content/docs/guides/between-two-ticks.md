---
title: "Interpolation"
description: "Ticks and frames don't line up. With smooth: true, @arcadekit/three draws each entity between its last two positions, so steady motion looks steady."
---

A game ticks sixty times a second while a screen shows as many frames as it can, so ticks and frames don't line up: some frames follow one tick, some two, some none. An entity drawn where the last tick left it stutters even when it moves at a steady speed. See [ticks and frames](../concepts/ticks-and-frames.md).

With `smooth: true`, `Three.instances` and `Three.objects` **interpolate** each entity between its last two positions: they draw it `Frame.alpha` of the way from where it was a tick ago to where it is now.

```ts
import { Three } from "@arcadekit/three";
import { Component } from "arcadekit";
import { IcosahedronGeometry, MeshStandardMaterial } from "three";

const Rock = Component.tag("game/Rock");

const Rocks = Three.instances("game/Rocks", {
  of: Rock,
  geometry: new IcosahedronGeometry(1),
  material: new MeshStandardMaterial({ color: "#8a8f98" }),
  smooth: true,
  snap: 50, // moving further than this in one tick is a jump, not motion
});
```

## The picture lags one tick

Interpolation is what a real-time game wants, but it is off by default because of what it implies: the picture is up to one tick behind the game.

- Just after a tick, at an `alpha` of 0, an entity is drawn where it was before that tick.
- A game stepped by hand and drawn with `app.frame(0)`, as a test does, shows its last tick only on the next one.
- A game that ticks when its player moves, run with `ticks: "whenNeeded"`, receives an `alpha` of 1 while it rests, so it is drawn where it is.

## How values are interpolated

- Positions and scales are interpolated linearly. Rotations take the shorter path: a quaternion towards whichever of the target and its negation is closer, and a flat game's angle the shorter way round.
- An entity not drawn in the previous frame is drawn where it is: a new entity, one reusing another's slot, one that was hidden, and every entity in the first frame, after a load, or after a frame in which the system didn't run.
- `snap` is how far an entity can move in one tick and still be interpolated. An entity that moved further, such as one that wrapped from one edge of the world to the other, is drawn where it is. Without `snap`, any distance counts as motion. It is one distance per kind, in scene units.
- When several ticks ran since the last frame, an entity starts from where it was last drawn, which is more than a tick back: for that one frame it moves faster. When no tick ran, it stays between the same two positions as in the previous frame.
- A position changed without a tick, by an action dispatched between ticks or by hand, becomes the target, interpolated from where the entity was coming from.
- An [instance's colour](instances-and-objects.md#per-instance-colour) is interpolated too, however far it changes.

## What it stores, and what it costs

The previous value of each component is stored by the renderer, per entity, and isn't part of the world: a game drawn this way has the same hash, log and save as one that isn't drawn at all.

It costs about 18 ns more per entity per frame for a position, and 63 ns more for position, rotation and scale.

## In your own frame systems

To interpolate in a frame system of your own, compute the position at `(yield* Frame).alpha` from a velocity or a previous position your simulation keeps, as the frame example in [ticks and frames](../concepts/ticks-and-frames.md#the-frame) does.

## Read more

- [Instances and objects](instances-and-objects.md), which accept `smooth` and `snap`.
- [`Three`](/reference/three/Three) in the API reference.
