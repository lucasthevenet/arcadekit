---
title: "Components"
description: "A component is a kind of data an entity can have. This guide covers its name, the kinds of field, tags, singletons, relations, and the components for where a thing is."
---

A component is a kind of data an entity can have. This guide covers its name, the kinds of field, tags, singletons, relations, and the components for where a thing is.

## Defining one

```ts
import { Component, Field } from "arcadekit";
import { Schema } from "effect";

interface Sprite {
  readonly frame: number;
}

const Hero = Component.define("game/Hero", {
  hp: Field.i32, // a number, in a typed array
  target: Field.entity, // an entity's id
  name: Field.json<string>(), // plain data
  inventory: Field.json<readonly string[]>(),
  born: Field.schema(Schema.Date), // any value a schema describes
  sprite: Field.transient<Sprite>(), // not saved
});
```

The name, `"game/Hero"`, is the component's identity in a world. A save names its components that way, so give each a prefix of its feature and keep it once a game has saves.

- A world that meets two different components with one name refuses the second, where it is spawned, added, queued or queried.
- Nothing is shared between worlds, so two apps in one process, or a module evaluated twice, can each define a component with the same name.
- The name is part of the component's type, which is how the compiler tells two components with the same fields apart. Write it as a literal: a name built at run time is just `string`.

## The kinds of field

A number goes in a typed field: `f32`, `f64`, `i32`, `u32`, `u16`, `u8`, or `entity` for [an id](../concepts/entities-and-systems.md#an-entitys-id), which takes eight bytes. Each is a column of a typed array, which is what makes a loop over many entities fast.

Anything else says, where it is defined, what a snapshot and the hash do with it:

| Field | Holds | Saved and hashed |
| --- | --- | --- |
| `Field.json<T>()` | Plain data: text, a number, a boolean, a bigint, null or undefined, or an array or object made of text, numbers, booleans and null | As it is. An array or object as the text `JSON.stringify` gives for it |
| `Field.schema(schema)` | Any value an Effect schema describes: a `Date`, a bigint inside an object, a class with a schema | In the schema's JSON form |
| `Field.ref<T>(codec)` | Any value, with an `encode` and `decode` of your own to plain data and back | In its encoded form |
| `Field.transient<T>()` | A handle or a cache another system can make again | No. It is undefined in a world loaded from a snapshot |

- The hash covers exactly what a snapshot saves, in the form it is saved in, so a world that loads a snapshot hashes the same.
- A value that isn't plain data in a `json` field, or one a codec or schema won't take, can't be saved: the snapshot is refused and names the field. A loaded value that a codec refuses is refused the same way.
- What comes back from a `json` field is what JSON makes of it: a `Date` inside an object comes back as text. Give such a value a schema.
- A `schema` or `ref` field is encoded once per value for every hash, and an array or object in a `json` field is turned into text. Keep them for what is small or rare. Numbers that change every tick belong in typed fields.

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

An id that was kept past its entity's despawn [names nobody](../concepts/entities-and-systems.md#an-entitys-id), even once its slot is given to a new entity.

Once a game is running, changes should come from the simulation (a system, a handler, a script) so that a replay has them. See [determinism](../concepts/determinism.md).

A component added with no value is all zeros, and a number left out of a value is 0, never NaN. `world.set` writes the fields it is given and leaves the others as they are.

## Tags and sparse storage

A tag is a component with no fields. A component that is added and removed often, or that few entities have, is better stored in a sparse set, so that gaining or losing it doesn't move the entity between tables:

```ts
import { Component } from "arcadekit";

const Stunned = Component.tag("game/Stunned", { storage: "sparse" });
```

## Singletons

A singleton is data there is one of per world: the score, whose turn it is, the level being played. `yield*` gives the world's value, an object whose fields are read and written in place, with no entity, no query and no loop. Its fields are a component's, of the same kinds, and its third argument is the value it has in a world that has not written it.

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

A singleton is in the world, so it is saved, hashed, and put back when an action is refused.

- Until it is written it has its initial value and is neither saved nor hashed. Reading it changes nothing, so a plugin that only reads a singleton doesn't change the hash of the game it watches.
- A game loaded from a save in which it had never been written starts it at the initial value of the build that loads.
- Its name is one of the world's component names. It is listed in a plugin's `components` so that a save which names it can be loaded, and a [migration](saving-and-loading.md) changes it by name with `Migrate`, as it changes a component.
- No entity has it and no query visits it: spawning or adding it throws.

A `Resource` is the other kind of single value: configuration with a default that a layer can override, such as gravity. It is not game state and isn't saved.

## Relations

A relation is a component that points at another entity, its `target`, and stays correct when that entity goes: a parent and its children, a target, an owner. Use one, and not a bare `Field.entity`, for a reference that must not dangle.

```ts
import { App, Component, Field, Plugin } from "arcadekit";
import { Effect } from "effect";

const Position = Component.define("game/Position", {
  x: Field.f32,
  y: Field.f32,
});
const ChildOf = Component.relation("scene/ChildOf", {
  onTargetDespawn: "despawn", // a child goes with its parent
});
const Targets = Component.relation("ai/Targets", {
  onTargetDespawn: "remove", // whoever aimed at it aims at nothing
  storage: "sparse",
  fields: { since: Field.f32 }, // fields of its own, beside the target
});

const Rules = Plugin.make("game/Rules", {
  components: [Position, ChildOf, Targets],
});

const program = Effect.gen(function* () {
  const { world } = yield* App.make({ plugins: [Rules] });
  const tank = world.spawn(Position.of({ x: 0, y: 0 }));
  const truck = world.spawn(Position.of({ x: 9, y: 0 }));
  const turret = world.spawn(
    Position.of({ x: 0, y: 1 }),
    ChildOf.of({ target: tank })
  );
  world.get(turret, ChildOf)?.target; // its parent
  world.sources(tank, ChildOf); // the tank's children
  world.add(turret, ChildOf.of({ target: truck })); // another parent
  world.despawn(truck); // the turret goes with it, and whatever hangs from the turret
});
```

- `onTargetDespawn` says what a target's despawn does to whoever points at it. `"despawn"` takes them with it, and what points at them in turn, however deep. `"remove"` takes the relation off them and leaves them be.
- Either way nothing is left pointing at an entity that is gone, so a dangling reference can't be read as a live entity. A plain `Field.entity` is not kept this way: it holds whatever id was written to it, and whoever reads it checks `world.isAlive`.
- `world.sources(target, ChildOf)` gives the entities that point at one, in order of index. The world keeps track of who points at whom, so neither this nor a despawn looks at any other entity.
- A target is changed by adding the relation again, never by assigning: assigning to it, in `each` or with `world.set`, throws, and its raw column is typed as read-only. Fields of a relation's own are written like any others.
- A relation needs a target that is alive. Given none, it is refused where the mistake is. Given one that is gone already, what that entity's despawn would have done is done at once: the child doesn't outlive the call, or the relation isn't added.
- An entity has one target per relation. Another kind of link is another relation.
- A despawn goes through relations in order of name and through the entities that point in order of index, so the same world always loses the same entities in the same order.
- In a system or an action's handler, a relation is added, removed and given another target through `Commands`, like everything else that changes which entities exist.

In every other way a relation is a component: kept in tables or in a sparse set, read in a query, watched with `Query.added` and `Query.removed`, saved in a snapshot and counted in the hash. Who points at whom is worked out from it, and worked out again by a world that loads a snapshot, which refuses one whose relation points at nothing.

## Where a thing is

`Transform3d` is three components for where a thing is in three dimensions, `Position`, `Rotation` and `Scale`, and `Transform2d` is the same for a flat game. They are in arcadekit, not in a renderer, so the rules that move things and whatever draws them agree. [Where a thing is](transforms.md) is their guide.

## Read more

- [`Field`](/reference/arcadekit/Field), [`Entity`](/reference/arcadekit/ecs#entity), [`Component`](/reference/arcadekit/ecs#component), [`Singleton`](/reference/arcadekit/Singleton) and [`Transform3d`](/reference/arcadekit/Transform3d) in the API reference.
