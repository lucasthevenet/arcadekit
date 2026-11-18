---
title: "Between two ticks"
description: "A game's ticks and a screen's frames do not line up. With smooth: true, @arcadekit/three draws each entity between its last two places, so what moves evenly is seen to."
---

A game ticks sixty times a second and a screen shows as many frames as it likes, so the two do not line up: some frames follow one tick, some two, some none. Drawn where the last tick left it, a thing that moves evenly is seen to stutter. See [ticks and frames](../concepts/ticks-and-frames.md).

With `smooth: true`, `Three.instances` and `Three.objects` draw each entity between its last two places: at `Frame.alpha` of the way from where it was a tick ago to where it is.

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
  snap: 50, // further than this in one tick is not a move, it is a jump
});
```

## The picture is a tick behind

It is what a game that runs in real time wants, and it is off unless asked for, because of what it means: the picture is up to one tick behind the game.

- Just after a tick, at an `alpha` of 0, an entity is drawn where it was before the tick.
- A game that is stepped by hand and drawn with `app.frame(0)`, as a test does, would see its last tick only at the next.
- A game that ticks when its player moves, run with `ticks: "whenNeeded"`, is told an `alpha` of 1 while it rests, and is drawn where it is.

## What is drawn on the way

- Places and sizes go straight from one to the other. A turn goes by the shorter way: a quaternion towards whichever of the other and its opposite is nearer; a flat game's angle by the shorter way round.
- An entity that was not drawn in the frame before is drawn where it is: one that is new, one in a slot that was another's, one that was hidden, and every entity in the first frame, after a load, or after a frame the system did not run in.
- `snap` is how far an entity may go in one tick and still be drawn on the way. One that went further, off one edge of the world and in at the other, say, is drawn where it is. Left out, any distance is a move. It is one distance per kind, in the units of the scene.
- When several ticks ran since the last frame, an entity comes from where it was last drawn from, which is further back than a tick: for that one frame it moves faster than it did. When none ran, it is between the same two places as the frame before.
- A place changed with no tick, by an action dispatched between two or by hand, is where the entity goes to from where it was coming from.
- A [colour of an instance](instances-and-objects.md#a-colour-each) changes evenly too, however far it goes.

## What it keeps, and what it costs

What it keeps, the value each component had a tick ago, is the renderer's own, by entity, and no part of the world: a game drawn this way has the same hash, log and save as one that is not drawn at all.

It costs a frame about 18 ns more per entity for a place, and 63 ns more for a place, a turn and a size.

## A frame system of your own

A frame system of the game's own that draws between two ticks works the place out itself, at `(yield* Frame).alpha`, from a velocity or a previous position the simulation keeps. arcadekit has no helper for it.

## Read more

- [Instances and objects](instances-and-objects.md), which take `smooth` and `snap`.
- [`Three`](/reference/three/Three) in the API reference.
