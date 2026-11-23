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
- A `json` field takes a type JSON holds: `Field.json<Date>()` or an object with a `Map` in it doesn't compile. Give such values a schema instead.
- A value a `json`, `ref`, `schema` or `transient` field holds is read-only all the way down. Replace it, with `world.set` or by assigning the field in `each`, rather than changing it in place: a change in place would be seen by no change query and undone by no refused action, so it doesn't compile.
- Every hash encodes each `schema` and `ref` value, and stringifies each array or object in a `json` field. Use these fields for small or rarely changing data, and keep numbers that change every tick in numeric fields.

## Creating and changing entities

`Hero.of({...})` creates a component value for a spawn. A system, a handler or a plugin's `setup` spawns through `Commands`, which it requests with the components it spawns. Code outside the simulation, such as a test or the entry point, can't change the world: it reads it with `app.read`, and changes the game with an [action](events-and-actions.md), whose handler makes the change:

```ts
import {
  Action,
  App,
  Commands,
  Component,
  Field,
  Plugin,
  Query,
  World,
} from "arcadekit";
import { Effect, Schema } from "effect";

const Position = Component.define("game/Position", {
  x: Field.f32,
  y: Field.f32,
});
const Placed = Query.all(Position);

const Throw = Action.define("game/Throw", Schema.Struct({ x: Schema.Number }));
const toss = Action.handler(Throw, function* ({ x }) {
  return (yield* Commands.spawns(Position)).spawn(Position.of({ x, y: 2 }));
});

const Rules = Plugin.make("game/Rules", {
  handlers: [toss],
  setup: Effect.gen(function* () {
    (yield* Commands.spawns(Position)).spawn(Position.of({ x: 0, y: 0 }));
  }),
});

const program = Effect.gen(function* () {
  const app = yield* App.make(App.define({ plugins: [Rules] }));
  const thrown = yield* app.dispatch(Throw, { x: 4 });
  const world = yield* app.read(World);
  world.get(thrown, Position)?.x; // 4
  (yield* app.read(Placed)).count(); // 2
});
```

`app.read` runs an effect that requires only what reads: `World`, `Time`, a query with no `Query.writes`, a singleton or a state. One that requires `Commands`, `World.writes` or a query that writes doesn't compile, and the error says to issue an action. The world it gives has no `spawn`, `set` or `despawn`, and stays current: read it once and keep it. Every change is then in the action log, so a [replay](replays.md) reproduces it. See [determinism](../concepts/determinism.md).

An id kept after its entity is despawned [refers to no entity](../concepts/entities-and-systems.md#entity-ids), even once its slot is reused.

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

A **singleton** is data that exists once per world: the score, whose turn it is, the current level. `yield*` gives you the world's value to read. `yield* Score.writes` is the same value with fields you can assign, and only a system of the tick or a handler can ask for it. Its fields are component fields, of the same types, and the third argument is its initial value.

```ts
import { Component, Field, Plugin, Singleton, System } from "arcadekit";

const Score = Singleton.define(
  "game/Score",
  { points: Field.i32 },
  { points: 0 }
);
const Coin = Component.tag("game/Coin");

const Bonus = System.tick("game/Bonus", function* () {
  const score = yield* Score.writes;
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
import {
  Action,
  Commands,
  Component,
  EntityId,
  Field,
  Plugin,
  World,
} from "arcadekit";
import { Effect, Schema } from "effect";

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

// A tank with a turret on it.
const setup = Effect.gen(function* () {
  const commands = yield* Commands.spawns(Position, ChildOf);
  const tank = commands.spawn(Position.of({ x: 0, y: 0 }));
  commands.spawn(Position.of({ x: 0, y: 1 }), ChildOf.of({ target: tank }));
});

// Moves the turret onto the truck, then scraps the truck.
const Swap = Action.define(
  "game/Swap",
  Schema.Struct({ turret: EntityId, truck: EntityId })
);
const swap = Action.handler(Swap, function* ({ turret, truck }) {
  const world = yield* World;
  const commands = yield* Commands.spawns(ChildOf);
  const tank = world.get(turret, ChildOf)?.target; // its parent
  if (tank !== undefined) {
    world.sources(tank, ChildOf); // the tank's children
  }
  commands.add(turret, ChildOf.of({ target: truck })); // a new parent
  commands.despawn(truck); // despawns the turret too, and everything attached to it
});

export const Rules = Plugin.make("game/Rules", { handlers: [swap], setup });
```

- `onTargetDespawn` controls what happens to the entities pointing at a target when it is despawned. `"despawn"` despawns them too, along with whatever points at them, at any depth. `"remove"` removes the relation from them and leaves them otherwise untouched.
- Either way, nothing is left pointing at a despawned entity, so a dangling reference can never be read as a live one. A plain `Field.entity` gets no such guarantee: it holds whatever id was written, and readers check `world.isAlive` themselves.
- `world.sources(target, ChildOf)` returns the entities pointing at a target, ordered by index. The world tracks these links, so neither this call nor a despawn scans other entities. It takes a relation, and any other component doesn't compile.
- To change a target, add the relation again. `target` is read-only in `each`, in `world.set` and in its raw column, so assigning to it doesn't compile. A relation's own fields are written like any others.
- A relation requires a live target. Given bare, as `ChildOf` and not `ChildOf.of({ target })`, it doesn't compile on `Commands`, and the world refuses it where it is given. With a target that is already despawned, the despawn behaviour applies immediately: the child doesn't survive the call, or the relation isn't added.
- An entity has one target per relation. A different kind of link is a different relation.
- A despawn follows relations ordered by name and the pointing entities ordered by index, so the same world always loses the same entities in the same order.
- In a system or an action handler, add, remove and retarget relations through `Commands`, like any other structural change.

In every other way, a relation is a component: stored in tables or a sparse set, read in queries, watched with `Query.added` and `Query.removed`, saved in snapshots and included in the hash. The links between entities are derived from it, and rebuilt when a world loads a snapshot, which refuses a relation pointing at no entity.

## Transforms

`Transform3d` provides three components for an entity's place in three dimensions, `Position`, `Rotation` and `Scale`, and `Transform2d` provides the same for flat games. They live in arcadekit rather than in a renderer, so your rules and whatever draws them agree on where things are. See [transforms](transforms.md).

## Read more

- [`Field`](/reference/arcadekit/Field), [`Entity`](/reference/arcadekit/ecs#entity), [`Component`](/reference/arcadekit/ecs#component), [`Singleton`](/reference/arcadekit/Singleton) and [`Transform3d`](/reference/arcadekit/Transform3d) in the API reference.
