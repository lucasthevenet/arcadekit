---
title: "Components"
description: "A component is a kind of data an entity can have. This guide covers the kinds of field, tags, singletons, relations, and the components for where a thing is."
---

A component is a kind of data an entity can have. This guide covers the kinds of field, tags, singletons, relations, and the components for where a thing is.

## Defining one

```ts
import { Component, Field } from "arcadekit";
import { Schema } from "effect";

const Hero = Component.define("game/Hero", {
  hp: Field.i32, // a number, in a typed array
  target: Field.entity, // an entity's id
  name: Field.json<string>(), // plain data
  inventory: Field.json<readonly string[]>(),
  born: Field.schema(Schema.Date), // any value a schema describes
});
```

The name, `"game/Hero"`, is the component's identity. A save names its components that way, so give each a prefix of its feature and keep it once a game has saves.

A number goes in a typed field: `f32`, `f64`, `i32`, `u32`, `u16`, `u8`, or `entity` for an id. Each is a column of a typed array, which is what makes a loop over many entities fast.

Anything else says what a save and the hash do with it:

| Field | Holds | Saved and hashed |
| --- | --- | --- |
| `Field.json<T>()` | Plain data: text, numbers, booleans, null, and arrays and objects of them | As it is |
| `Field.schema(schema)` | Any value an Effect schema describes: a `Date`, a class | In the schema's JSON form |
| `Field.ref<T>(codec)` | Any value, with an `encode` and `decode` of your own | In its encoded form |
| `Field.transient<T>()` | A handle or a cache another system can make again | No |

Keep the non-number kinds for what is small or rare. Numbers that change every tick belong in typed fields.

## Making and changing entities

`Hero.of({...})` is a value of a component, for a spawn. A system spawns through `Commands`, and code outside the simulation (a test, the entry point) through `app.world`:

```ts
import { App, Commands, Component, Field, Plugin } from "arcadekit";
import { Effect } from "effect";

const Position = Component.define("game/Position", {
  x: Field.f32,
  y: Field.f32,
});

const Rules = Plugin.make("game/Rules", {
  components: [Position],
  setup: Effect.gen(function* () {
    (yield* Commands).spawn(Position.of({ x: 0, y: 0 }));
  }),
});

const program = Effect.gen(function* () {
  const app = yield* App.make({ plugins: [Rules] });
  const rock = app.world.spawn(Position.of({ x: 4, y: 2 }));
  app.world.set(rock, Position, { y: 3 });
  app.world.get(rock, Position)?.x; // 4
  app.world.despawn(rock);
  app.world.isAlive(rock); // false, for good
});
```

Once a game is running, changes should come from the simulation (a system, a handler, a script) so that a replay has them. See [determinism](../concepts/determinism.md).

## Tags and sparse storage

A tag is a component with no fields. A component that is added and removed often is better stored in a sparse set, so that gaining or losing it doesn't move the entity between tables:

```ts
import { Component } from "arcadekit";

const Stunned = Component.tag("game/Stunned", { storage: "sparse" });
```

## Singletons

A singleton is data there is one of per world: the score, whose turn it is, the level being played. `yield*` gives the world's value, an object whose fields are read and written in place.

```ts
import { Component, Field, Plugin, Singleton, System } from "arcadekit";

const Score = Singleton.define(
  "game/Score",
  { points: Field.i32 },
  { points: 0 }
);
const Coin = Component.tag("game/Coin");

const Bonus = System.make("game/Bonus", function* () {
  const score = yield* Score;
  score.points += 1;
});

const Rules = Plugin.make("game/Rules", {
  components: [Coin, Score], // a singleton is listed with the components
  systems: [Bonus],
});
```

A singleton is in the world, so it is saved, hashed, and put back when an action is refused. Until it is written it has its initial value and is in neither.

A `Resource` is the other kind of single value: configuration with a default that a layer can override, such as gravity. It is not game state and isn't saved.

## Relations

A relation is a component that points at another entity and stays correct when that entity goes: a parent and its children, a target, an owner.

```ts
import { Component } from "arcadekit";

const ChildOf = Component.relation("scene/ChildOf", {
  onTargetDespawn: "despawn", // a child goes with its parent
});
const Targets = Component.relation("ai/Targets", {
  onTargetDespawn: "remove", // whoever aimed at it aims at nothing
  storage: "sparse",
});
```

An entity gets one with `ChildOf.of({ target: tank })`. `world.sources(tank, ChildOf)` gives the entities that point at the tank. Nothing is ever left pointing at an entity that is gone. A plain `Field.entity` is not kept this way: whoever reads it checks `world.isAlive`.

## Where a thing is

`Transform3d` is three components for where a thing is in three dimensions, and `Transform2d` is the same for a flat game. They are in arcadekit, not in a renderer, so the rules that move things and whatever draws them agree.

```ts
import { Commands, Component, Plugin, Transform3d } from "arcadekit";
import { Effect } from "effect";

const Rock = Component.tag("game/Rock");

const Rules = Plugin.make("game/Rules", {
  plugins: [Transform3d.plugin], // lists the three, so a save that names them loads
  components: [Rock],
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

An entity has the ones it needs. One that is only somewhere has a `Position`. `Transform2d` has `Position` (`x`, `y`), `Rotation` (`angle`) and `Scale` (`x`, `y`).

## Read more

- [Fields](/reference/arcadekit#fields), [an entity's id](/reference/arcadekit#an-entitys-id), [singletons](/reference/arcadekit#singletons), [relations](/reference/arcadekit#relations) and [where a thing is](/reference/arcadekit#where-a-thing-is) in the reference.
