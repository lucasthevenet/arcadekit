---
title: "Transforms"
description: "Transform3d and Transform2d are the components for an entity's position, rotation and scale. They belong to arcadekit, so your rules and your renderer agree on where things are."
---

**`Transform3d`** provides three components for an entity's place in three dimensions: its position, its rotation and its scale. **`Transform2d`** provides the same for flat games. They live in arcadekit rather than in a renderer, so everything that needs to know where things are agrees on it: the rules that move them, the systems that draw them, and anything you add later.

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
  plugins: [Transform3d.plugin], // lists the three, so saves containing them load
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

| Component | Fields | Name |
| --- | --- | --- |
| `Transform3d.Position` | `x`, `y`, `z`, in your scene's units | `"arcadekit/Transform3d.Position"` |
| `Transform3d.Rotation` | `x`, `y`, `z`, `w`: a quaternion | `"arcadekit/Transform3d.Rotation"` |
| `Transform3d.Scale` | `x`, `y`, `z`: 1 is the size the entity is modelled at | `"arcadekit/Transform3d.Scale"` |

- They are ordinary components: 32-bit floats in columns, written by your systems, saved, hashed and replayed. arcadekit itself draws nothing.
- Give an entity only the ones it needs. An entity that only has a location has a `Position`; `Rotation` and `Scale` are for entities that rotate or have a size of their own.
- `Transform3d.plugin` registers them. A plugin that stores them depends on it, as does a renderer plugin that reads them.
- Systems move entities with a loop over the columns, as `Drift` does. `Transform3d.axisAngle(x, y, z, angle)` returns the `Rotation` value for a rotation of `angle` radians about an axis, given as a direction of any length. It allocates an object, so use it for a spawn or `world.set`, not inside such a loop.
- A `Rotation` represents its rotation, not its length. A quaternion of any length stands for the rotation of the unit quaternion in its direction, and readers normalise it: one that drifts from length 1 in your rules is still drawn as the same rotation.

## In two dimensions

`Transform2d` provides the same three components without the third dimension:

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

| Component | Fields | Name |
| --- | --- | --- |
| `Transform2d.Position` | `x`, `y` | `"arcadekit/Transform2d.Position"` |
| `Transform2d.Rotation` | `angle`, in radians | `"arcadekit/Transform2d.Rotation"` |
| `Transform2d.Scale` | `x`, `y` | `"arcadekit/Transform2d.Scale"` |

A positive `angle` rotates from the x axis towards the y axis: counterclockwise when y points up, clockwise when it points down.

## Guidelines

- **Use them for everything that is drawn**, rather than a position component of your own, so your rules and your renderer agree. [`@arcadekit/three`](drawing-with-three.md) draws from them and has no components of its own.
- **Use one of the two per entity, never both.** They are separate components with separate names, and nothing keeps them in sync: a system that queries `Transform3d.Position` doesn't match an entity that only has a `Transform2d.Position`, and a plugin written for one doesn't read the other. `@arcadekit/three` draws an entity with both positions once, from the 3D one, and ignores its `Transform2d` rotation and scale. Nothing refuses it.
- **Always give a `Scale` a value.** A component added without a value is all zeros: a `Position` at the origin and a `Rotation` drawn as no rotation are fine, but a zero `Scale` is drawn as nothing.
- **An omitted number is 0**, never `NaN`. `of` requires every field, so the compiler asks for each, and a flat game using `Transform3d` sets every `z`. `world.set` writes only the fields you pass: a field you name without a value keeps its current value.
- **A `Transform2d` has no depth.** In a flat game, the renderer decides what is drawn in front, per kind of entity.

## Read more

- [`Transform3d`](/reference/arcadekit/Transform3d) and [`Transform2d`](/reference/arcadekit/Transform2d) in the API reference.
- [Components](components.md), and [drawing with Three.js](drawing-with-three.md) for rendering them.
