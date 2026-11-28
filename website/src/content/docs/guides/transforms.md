---
title: "Transforms"
description: "Transform3d and Transform2d are the components for an entity's position, rotation and scale. They belong to arcadekit, so your rules and your renderer agree on where things are."
---

A **transform** is an entity's place in the game: its position, its rotation and its scale. `Transform3d` provides a component for each in three dimensions, and `Transform2d` provides the same for flat games. They live in arcadekit rather than in a renderer, so everything that needs to know where things are agrees on it: the rules that move them, the systems that draw them, and anything you add later.

## Place an entity in three dimensions

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
const Placed = Query.all(Transform3d.Position).pipe(
  Query.writes(Transform3d.Position)
);

const Drift = System.tick("game/Drift", function* () {
  const { delta } = yield* Time;
  (yield* Query.View(Placed)).eachChunk((start, end, position) => {
    for (let i = start; i < end; i++) {
      position.x[i] = position.x[i]! + 2 * delta;
    }
  });
});

const Rules = Plugin.make("game/Rules", {
  systems: [Drift],
  setup: Effect.gen(function* () {
    (yield* Commands.spawns(
      Rock,
      Transform3d.Position,
      Transform3d.Rotation,
      Transform3d.Scale
    )).spawn(
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

- They are ordinary components, with 32-bit floats in columns. Your systems write them, and they are saved, hashed and replayed like any other component. arcadekit itself draws nothing.
- Give an entity only the ones it needs. An entity that has only a location has a `Position` alone. `Rotation` and `Scale` are for entities that turn or have a size of their own.
- Move entities with a loop over the columns, as `Drift` does.
- `Transform3d.axisAngle(x, y, z, angle)` returns the `Rotation` value for a rotation of `angle` radians about an axis, given as a direction of any length. It allocates an object, so use it for a spawn or `world.set`, not inside a loop over the columns.
- Only the direction of a `Rotation` counts, not its length. A quaternion of any length stands for the rotation of the unit quaternion in its direction, and readers normalise it. A rotation that drifts from length 1 in your rules is still drawn as the same rotation.

## Place an entity in two dimensions

`Transform2d` provides the same three components without the third dimension:

```ts
import { Commands, Component, Plugin, Transform2d } from "arcadekit";
import { Effect } from "effect";

const Card = Component.tag("game/Card");

const Rules = Plugin.make("game/Rules", {
  setup: Effect.gen(function* () {
    (yield* Commands.spawns(
      Card,
      Transform2d.Position,
      Transform2d.Rotation,
      Transform2d.Scale
    )).spawn(
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

## Teleport an entity

A **teleport** moves an entity, in one tick, from one place to another it doesn't travel through. An entity drawn between two ticks is drawn on its way from where it was to where it is, so give one that teleports `Teleports`, and count each teleport in it:

```ts
import {
  Commands,
  Component,
  Plugin,
  Query,
  System,
  Transform2d,
} from "arcadekit";
import { Effect } from "effect";

const Ship = Component.tag("game/Ship");
const Ships = Query.all(Transform2d.Position, Transform2d.Teleports).pipe(
  Query.with(Ship),
  Query.writes(Transform2d.Position, Transform2d.Teleports)
);

// Off the right edge, and in at the left.
const Wrap = System.tick("game/Wrap", function* () {
  (yield* Query.View(Ships)).eachChunk((start, end, position, teleports) => {
    for (let i = start; i < end; i++) {
      if (position.x[i]! > 400) {
        position.x[i] = position.x[i]! - 800;
        teleports.count[i] = teleports.count[i]! + 1;
      }
    }
  });
});

const Rules = Plugin.make("game/Rules", {
  systems: [Wrap],
  setup: Effect.gen(function* () {
    (yield* Commands.spawns(
      Ship,
      Transform2d.Position,
      Transform2d.Teleports
    )).spawn(
      Ship,
      Transform2d.Position.of({ x: 0, y: 0 }),
      Transform2d.Teleports
    );
  }),
});
```

- `Transform2d.Teleports` and `Transform3d.Teleports` hold one number, `count`, which the tick that teleports the entity adds one to. Added bare, it is 0.
- An entity whose count changed since the previous frame is drawn where it is, at its position, rotation and scale, until the next tick moves it on. Every reader draws it so: `Three.instances` and `Three.objects` with `smooth: true`, and a frame system of your own that reads `Transform2d.smooth` or `Transform3d.smooth`. See [interpolation](between-two-ticks.md).
- It is a component of the game, saved, hashed and replayed. A rewind takes a teleport back with the tick that made it, and a peer that hears of one late draws the entity where it landed.
- An entity without it costs nothing. One with it costs four bytes in the world, and a look at its count once a frame while something is drawn between ticks.

## Choose an entity's transforms

- **Use them for everything that is drawn**, rather than a position component of your own, so your rules and your renderer agree. [`@arcadekit/three`](drawing-with-three.md) draws from them and has no components of its own.
- **Use one of the two per entity, never both.** They are separate components with separate names, and nothing keeps them in sync. A system that queries `Transform3d.Position` doesn't match an entity that has only a `Transform2d.Position`, and a plugin written for one doesn't read the other. Each kind of `@arcadekit/three` names the module it draws from and reads nothing of the other. An entity with both positions is therefore drawn by a kind of each, each from its own position.
- **Add them bare when the default fits.** Added without a value, a `Position` is at the origin, a `Rotation` turns nothing, and a `Scale` is 1 along each axis.
- **An omitted number is 0**, never `NaN`. `of` requires every field, so the compiler asks for each, and a flat game using `Transform3d` sets every `z`. `world.set` writes only the fields you pass, and a field you name without a value keeps its current value.
- **A `Transform2d` has no depth.** In a flat game, the renderer decides what is drawn in front, per kind of entity.

## Read more

- [`Transform3d`](/reference/arcadekit/Transform3d) and [`Transform2d`](/reference/arcadekit/Transform2d) in the API reference.
- [Components](components.md), and [drawing with Three.js](drawing-with-three.md) for rendering them.
