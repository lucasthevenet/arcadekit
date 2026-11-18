---
title: "Where a thing is"
description: "Transform3d and Transform2d are the components for where a thing is: its position, which way it is turned, and how large it is. They are arcadekit's own, so the rules that move things and whatever draws them agree."
---

`Transform3d` is three components for where a thing is in three dimensions: its position, which way it is turned, and how large it is. `Transform2d` is the same for a flat game. They are in arcadekit, not in a renderer, so that whatever needs to know where things are agrees on it: the rules that move them, what draws them, and what comes after.

## In three dimensions

```ts
import {
  Commands,
  Component,
  Plugin,
  Query,
  System,
  Time,
  Transform3d,
} from "arcadekit";
import { Effect } from "effect";

const Rock = Component.tag("game/Rock");
const Placed = Query.all(Transform3d.Position);

const Drift = System.make("game/Drift", function* () {
  const { delta } = yield* Time;
  (yield* Placed).eachChunk((start, end, position) => {
    for (let i = start; i < end; i++) {
      position.x[i] = position.x[i]! + 2 * delta;
    }
  });
});

const Rules = Plugin.make("game/Rules", {
  plugins: [Transform3d.plugin], // lists the three, so a save that names them loads
  components: [Rock],
  systems: [Drift],
  setup: Effect.gen(function* () {
    (yield* Commands).spawn(
      Rock,
      Transform3d.Position.of({ x: 0, y: 4, z: 0 }),
      Transform3d.Rotation.of(Transform3d.axisAngle(0, 0, 1, Math.PI / 2)),
      Transform3d.Scale.of({ x: 2, y: 2, z: 2 })
    );
  }),
});
```

| Component | Fields | Named |
| --- | --- | --- |
| `Transform3d.Position` | `x`, `y`, `z`, in the units of the game's space | `"arcadekit/Transform3d.Position"` |
| `Transform3d.Rotation` | `x`, `y`, `z`, `w`: a quaternion | `"arcadekit/Transform3d.Rotation"` |
| `Transform3d.Scale` | `x`, `y`, `z`: 1 is the size a thing is made at | `"arcadekit/Transform3d.Scale"` |

- They are ordinary components: 32-bit floats in columns, written by the game's systems, saved, hashed and replayed. Nothing here draws.
- An entity has the ones it needs. One that is only somewhere has a `Position`. `Rotation` and `Scale` are for the ones that turn or have a size of their own.
- `Transform3d.plugin` lists them. A plugin that stores them depends on it, as the plugin of a renderer that reads them does.
- A system moves things in a loop over the columns, as `Drift` does. `Transform3d.axisAngle(x, y, z, angle)` gives the value of a `Rotation` that turns by `angle` radians about an axis, a direction of any length. It makes an object, so it is for a spawn or a `world.set`, not for such a loop.
- A `Rotation` is its turn and not its length. A quaternion of any length stands for the turn of the one of length 1 along it, and what reads one takes it so: one that the rules let drift from length 1 is drawn as the same turn.

## In a flat game

`Transform2d` is the same three components with no third dimension:

```ts
import { Commands, Component, Plugin, Transform2d } from "arcadekit";
import { Effect } from "effect";

const Card = Component.tag("game/Card");

const Rules = Plugin.make("game/Rules", {
  plugins: [Transform2d.plugin],
  components: [Card],
  setup: Effect.gen(function* () {
    (yield* Commands).spawn(
      Card,
      Transform2d.Position.of({ x: 120, y: 80 }),
      Transform2d.Rotation.of({ angle: Math.PI / 6 }),
      Transform2d.Scale.of({ x: 2, y: 2 })
    );
  }),
});
```

| Component | Fields | Named |
| --- | --- | --- |
| `Transform2d.Position` | `x`, `y` | `"arcadekit/Transform2d.Position"` |
| `Transform2d.Rotation` | `angle`, in radians | `"arcadekit/Transform2d.Rotation"` |
| `Transform2d.Scale` | `x`, `y` | `"arcadekit/Transform2d.Scale"` |

A positive `angle` turns from the x axis towards the y axis: anticlockwise where y points up, clockwise where it points down.

## What to keep to

- **Use them for anything that is drawn**, and not a position of the game's own, so that the rules and what draws agree. [`@arcadekit/three`](drawing-with-three.md) draws from them and has no components of its own.
- **One of the two for a thing, never both.** They are different components, with names of their own, and nothing keeps one in step with the other: a system that queries `Transform3d.Position` doesn't find an entity that has only `Transform2d.Position`. An entity with both positions is drawn by `@arcadekit/three` once, from the one of three dimensions, and its `Transform2d` rotation and scale are then not read. Nothing refuses it.
- **Give a `Scale` its value.** A component added with no value is all zeros: a `Position` at the origin, a `Rotation` that is drawn as not turned at all, and a `Scale` of no size, which is drawn as nothing.
- **A number left out of a value is 0**, never NaN. `of` takes every field, so the compiler asks for each, and a flat game that uses `Transform3d` gives every `z`. `world.set` writes the fields it is given: one it names and gives no value for is left as it was.

## Not done yet

- A plugin written for one of the two doesn't read the other. Code that should work in both, as a renderer does, asks for both.
- A `Transform2d` has no depth: what is in front of what in a flat game is for what draws it to say.

## Read more

- [`Transform3d`](/reference/arcadekit/Transform3d) and [`Transform2d`](/reference/arcadekit/Transform2d) in the API reference.
- [Components](components.md), and [drawing with Three.js](drawing-with-three.md) for what draws from them.
