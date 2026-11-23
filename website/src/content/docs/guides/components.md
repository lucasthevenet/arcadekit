---
title: "Components"
description: "A component is a kind of data an entity can have. Learn how to define components, choose field types, and use tags, singletons and relations."
---

A **component** is a kind of data an entity can have, such as a position, health, or a `Stunned` tag. This guide covers defining components, field types, tags and sparse storage, singletons, and relations.

## Defining a component

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

The first argument, `"game/Hero"`, is the component's name. It identifies the component within a world and in saves, so prefix it with the feature it belongs to, and keep it unchanged once your game has saves.

- A world refuses a second, different component with the same name, wherever it first meets it: a spawn, an add, a command or a query.
- Worlds share nothing, so two apps in one process, or a module evaluated twice, can each define a component with the same name.
- The name is part of the component's type, which lets the compiler tell apart two components with the same fields. Write it as a string literal: a name built at run time has the type `string`.

## Field types

Numeric fields are stored in typed arrays: `f32`, `f64`, `i32`, `u32`, `u16`, `u8`, and `entity` for an [entity id](../concepts/entities-and-systems.md#entity-ids), which takes eight bytes. Each field is a column of a typed array, which is what makes loops over many entities fast.

Other values use a field type that declares how snapshots and the hash treat them:

| Field | Holds | Saved and hashed |
| --- | --- | --- |
| `Field.json<T>()` | Plain data: a string, number, boolean, bigint, `null` or `undefined`, or an array or object of strings, numbers, booleans and `null` | As is. Arrays and objects as the text `JSON.stringify` produces |
| `Field.schema(schema)` | Any value an Effect schema describes: a `Date`, a bigint inside an object, a class with a schema | In the schema's JSON encoding |
| `Field.ref<T>(codec)` | Any value, with your own `encode` and `decode` to plain data and back | In its encoded form |
| `Field.transient<T>()` | A handle or cache that another system can rebuild | Neither. It is `undefined` in a world loaded from a snapshot |

- The hash covers exactly what a snapshot saves, in its saved form, so a world loaded from a snapshot has the same hash.
- A snapshot fails, naming the field, when it meets a value it can't encode: a non-plain value in a `json` field, or one a codec or schema rejects. Loading fails the same way when a codec rejects a value.
- A `json` field returns what JSON makes of a value: a `Date` inside an object comes back as a string. Give such values a schema instead.
- Every hash encodes each `schema` and `ref` value, and stringifies each array or object in a `json` field. Use these fields for small or rarely changing data, and keep numbers that change every tick in numeric fields.

## Creating and changing entities

`Hero.of({...})` creates a component value for a spawn. A system, a handler or a plugin's `setup` spawns through `Commands`, which it requests with the components it spawns. Code outside the simulation, such as a test or the entry point, uses `app.world`:

```ts
import { App, Commands, Component, Field, Plugin } from "arcadekit";
import { Effect } from "effect";

const Position = Component.define("game/Position", {
  x: Field.f32,
  y: Field.f32,
});

const Rules = Plugin.make("game/Rules", {
  setup: Effect.gen(function* () {
    (yield* Commands.spawns(Position)).spawn(Position.of({ x: 0, y: 0 }));
  }),
});

const program = Effect.gen(function* () {
  const app = yield* App.make(App.define({ plugins: [Rules] }));
  const rock = app.world.spawn(Position.of({ x: 4, y: 2 }));
  app.world.set(rock, Position, { y: 3 });
  app.world.get(rock, Position)?.x; // 4
  app.world.despawn(rock);
  app.world.isAlive(rock); // false, permanently
});
```

An id kept after its entity is despawned [refers to no entity](../concepts/entities-and-systems.md#entity-ids), even once its slot is reused.

Once a game is running, make changes from the simulation (a system or a handler) so that a replay reproduces them. See [determinism](../concepts/determinism.md).

Inside the simulation, you name the components where you request what changes them:

| To | Request | Then |
| --- | --- | --- |
| Spawn an entity, or add a component | `yield* Commands.spawns(Bullet, Position)` | `commands.spawn(Bullet, Position.of({ x: 0, y: 0 }))`, `commands.add(entity, Bullet)` |
| Despawn an entity, or remove a component | `yield* Commands` | `commands.despawn(entity)`, `commands.remove(entity, Bullet)` |
| Set a component of one entity by id | `yield* World.writes(Health)` | `world.set(target, Health, { hp: 3 })` |
| Read one entity by id | `yield* World` | `world.get(target, Health)`, `world.has(target, Health)`, `world.isAlive(target)` |
| Write every entity that matches | A query with [`Query.writes`](queries.md#what-a-query-writes) | `view.each((health) => { health.hp -= 1 })` |

- Spawning, adding or setting a component you didn't name doesn't compile, and the error says where to name it.
- Naming them is how the compiler knows what a system changes, which is what lets it [check the order of your systems](systems.md#ordering).
- The world a system requests has no `spawn`, `despawn`, `add` or `remove`. The set of entities changes through `Commands` alone, which applies the change when the system finishes.

A component added without a value is all zeros, unless it says otherwise, and a number omitted from a value is 0, never `NaN`. `world.set` writes the fields you pass and leaves the others unchanged. A component whose zeros are wrong, a size say, gives `initial`, the value it has when added bare:

```ts
import { Component, EcsWorld, Field } from "arcadekit";

const Size = Component.define(
  "game/Size",
  { width: Field.f32, height: Field.f32 },
  { initial: { width: 1, height: 1 } }
);

const world = new EcsWorld();
world.spawn(Size); // 1 by 1
```

## Tags and sparse storage

A **tag** is a component with no fields. A component that is added and removed often, or that few entities have, works better in sparse storage, where adding or removing it doesn't move the entity between tables:

```ts
import { Component } from "arcadekit";

const Stunned = Component.tag("game/Stunned", { storage: "sparse" });
```

## Singletons

A **singleton** is data that exists once per world: the score, whose turn it is, the current level. `yield*` gives you the world's value, an object whose fields you read and write in place, with no entity, query or loop involved. Its fields are component fields, of the same types, and the third argument is its initial value.

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
  systems: [Bonus],
});
```

A singleton lives in the world, so it is saved, hashed, and restored when an action is refused.

- Until it is first written, it holds its initial value and is neither saved nor hashed. Reading it changes nothing, so a plugin that only reads a singleton doesn't change the hash of the game it observes.
- Loading a save in which a singleton was never written gives it the initial value of the build that loads it.
- Its name is one of the world's component names, by which a save finds it. Rename or change it in a [migration](saving-and-loading.md) with `Migrate`, as you would a component.
- No entity can have it and no query visits it: spawning or adding it throws.

A `Resource` is the other kind of single value: configuration with a default that a layer can override, such as gravity. It isn't game state and isn't saved.

## Relations

A **relation** is a component that points at another entity, its `target`, and stays consistent when that entity is despawned: a parent and its children, a target, an owner. Use a relation rather than a bare `Field.entity` for any reference that must never dangle.

```ts
import { App, Component, Field, Plugin } from "arcadekit";
import { Effect } from "effect";

const Position = Component.define("game/Position", {
  x: Field.f32,
  y: Field.f32,
});
const ChildOf = Component.relation("scene/ChildOf", {
  onTargetDespawn: "despawn", // a child is despawned with its parent
});
const Targets = Component.relation("ai/Targets", {
  onTargetDespawn: "remove", // whoever aimed at it now aims at nothing
  storage: "sparse",
  fields: { since: Field.f32 }, // fields of its own, beside the target
});

const Rules = Plugin.make("game/Rules", {});

const program = Effect.gen(function* () {
  const { world } = yield* App.make(App.define({ plugins: [Rules] }));
  const tank = world.spawn(Position.of({ x: 0, y: 0 }));
  const truck = world.spawn(Position.of({ x: 9, y: 0 }));
  const turret = world.spawn(
    Position.of({ x: 0, y: 1 }),
    ChildOf.of({ target: tank })
  );
  world.get(turret, ChildOf)?.target; // its parent
  world.sources(tank, ChildOf); // the tank's children
  world.add(turret, ChildOf.of({ target: truck })); // a new parent
  world.despawn(truck); // despawns the turret too, and everything attached to it
});
```

- `onTargetDespawn` controls what happens to the entities pointing at a target when it is despawned. `"despawn"` despawns them too, along with whatever points at them, at any depth. `"remove"` removes the relation from them and leaves them otherwise untouched.
- Either way, nothing is left pointing at a despawned entity, so a dangling reference can never be read as a live one. A plain `Field.entity` gets no such guarantee: it holds whatever id was written, and readers check `world.isAlive` themselves.
- `world.sources(target, ChildOf)` returns the entities pointing at a target, ordered by index. The world tracks these links, so neither this call nor a despawn scans other entities.
- To change a target, add the relation again. Assigning to `target`, in `each` or with `world.set`, throws, and its raw column is typed read-only. A relation's own fields are written like any others.
- A relation requires a live target. Without one, it is refused where the mistake happens. With a target that is already despawned, the despawn behaviour applies immediately: the child doesn't survive the call, or the relation isn't added.
- An entity has one target per relation. A different kind of link is a different relation.
- A despawn follows relations ordered by name and the pointing entities ordered by index, so the same world always loses the same entities in the same order.
- In a system or an action handler, add, remove and retarget relations through `Commands`, like any other structural change.

In every other way, a relation is a component: stored in tables or a sparse set, read in queries, watched with `Query.added` and `Query.removed`, saved in snapshots and included in the hash. The links between entities are derived from it, and rebuilt when a world loads a snapshot, which refuses a relation pointing at no entity.

## Transforms

`Transform3d` provides three components for an entity's place in three dimensions, `Position`, `Rotation` and `Scale`, and `Transform2d` provides the same for flat games. They live in arcadekit rather than in a renderer, so your rules and whatever draws them agree on where things are. See [transforms](transforms.md).

## Read more

- [`Field`](/reference/arcadekit/Field), [`Entity`](/reference/arcadekit/ecs#entity), [`Component`](/reference/arcadekit/ecs#component), [`Singleton`](/reference/arcadekit/Singleton) and [`Transform3d`](/reference/arcadekit/Transform3d) in the API reference.
