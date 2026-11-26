---
title: "Components"
description: "A component is a kind of data an entity can have. Learn how to define components, choose field types, and use tags."
---

A **component** is a kind of data an entity can have, such as a position, health or a `Stunned` tag. For a component that points at another entity, see [relations](relations.md), and for data that exists once per world, [singletons](singletons.md).

## Define a component

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

The first argument, `"game/Hero"`, is the component's name. It identifies the component within a world and in saves. Prefix it with the feature it belongs to, and keep it unchanged once your game has saves.

- A world refuses a second, different component with the same name, wherever it first meets it: a spawn, an add, a command or a query.
- Worlds share nothing, so two apps in one process, or a module evaluated twice, can each define a component with the same name.
- The name is part of the component's type, which lets the compiler tell two components with the same fields apart. Write it as a string literal, because a name built at run time has the type `string`.

## Choose a field type

The numeric field types are `f32`, `f64`, `i32`, `u32`, `u16`, `u8`, and `entity` for an [entity id](../concepts/entities-and-systems.md#an-id-is-an-index-and-a-generation), which takes eight bytes. Each numeric field is a column of a typed array, so a loop over many entities reads numbers in order.

Other values use a field type that declares how snapshots and the hash treat them:

| Field | Holds | Saved and hashed |
| --- | --- | --- |
| `Field.bool` | `true` or `false`, as 1 or 0 in a `Uint8Array`, which `eachChunk` hands out as it is | As a `u8`, so a save written while the field was a `Field.u8` loads with no migration |
| `Field.json<T>()` | Plain data: a string, number, boolean, bigint, `null` or `undefined`, or an array or object of strings, numbers, booleans and `null` | As is. Arrays and objects as the text `JSON.stringify` produces |
| `Field.schema(schema)` | Any value an Effect schema describes: a `Date`, a bigint inside an object, a class with a schema | In the schema's JSON encoding |
| `Field.ref<T>(codec)` | Any value, with your own `encode` and `decode` to plain data and back | In its encoded form |
| `Field.transient<T>()` | A handle or cache that another system can rebuild | Neither. It is `undefined` in a world loaded from a snapshot, and after a [rewind](capturing-and-rewinding.md) in a table that changed since the moment |

- The hash covers exactly what a snapshot saves, in its saved form, so a world loaded from a snapshot has the same hash.
- A snapshot fails, naming the field, when it meets a value it can't encode: a non-plain value in a `json` field, or one a codec or schema rejects. Loading fails the same way when a codec rejects a value.
- A `json` field takes only a type that JSON holds. `Field.json<Date>()`, or an object with a `Map` in it, doesn't compile. Give such values a schema instead.
- The value of a `json`, `ref`, `schema` or `transient` field is read-only all the way down. Replace it with `world.set` or by assigning the field in `each`. A change in place doesn't compile, because no change query would see it and no refused action would undo it.
- An `entity` field takes an entity and reads as an `Entity.Ref`, an id whose entity may be gone. The world's calls take an `Entity`, so pass the field through `world.live(hero.target)` first: it returns the entity while it is alive, and `undefined` once it is despawned.
- Every hash encodes each `schema` and `ref` value, and stringifies each array or object in a `json` field. Use these fields for small or rarely changing data, and keep numbers that change every tick in numeric fields.

## Create and change entities

`Hero.of({...})` creates a component value for a spawn. A system, a handler or a plugin's `setup` spawns through `Commands`, which it requests with the components it spawns. Code outside the simulation, such as a test or the entry point, can't change the world. It reads the world with `app.read`, and changes the game with an [action](events-and-actions.md), whose handler makes the change:

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

`app.read` runs an effect that requires only what reads: `World`, `Time`, a query that only reads, a singleton or a state. An effect that requires `Commands`, `World.writes` or a query that writes doesn't compile, and the error says to issue an action. The world that `app.read` gives has no `spawn`, `set` or `despawn`, and stays current, so read it once and keep it. Every change from outside is then in the action log, so a [replay](replays.md) reproduces it. See [determinism](../concepts/determinism.md).

An id kept after its entity is despawned [refers to no entity](../concepts/entities-and-systems.md#an-id-is-an-index-and-a-generation), even once its slot is reused.

Inside the simulation, you name the components where you request what changes them:

| To | Request | Then |
| --- | --- | --- |
| Spawn an entity, or add a component | `yield* Commands.spawns(Bullet, Position)` | `commands.spawn(Bullet, Position.of({ x: 0, y: 0 }))`, `commands.add(entity, Bullet)` |
| Despawn an entity, or remove a component | `yield* Commands` | `commands.despawn(entity)`, `commands.remove(entity, Bullet)` |
| Set a component of one entity by id | `yield* World.writes(Health)` | `world.set(target, Health, { hp: 3 })` |
| Read one entity by id, or a singleton | `yield* World` | `world.get(target, Health)`, `world.has(target, Health)`, `world.isAlive(target)`, `world.live(hero.target)`, `world.singleton(Score)` |
| Write every entity that matches | A query with [`Query.writes`](queries.md#name-what-a-query-writes) | `view.each((health) => { health.hp -= 1 })` |

- Spawning, adding or setting a component you didn't name doesn't compile, and the error says where to name it.
- The names tell the compiler what a system changes, so it can [check the order of your systems](systems.md#order-systems).
- The world a system requests has no `spawn`, `despawn`, `add` or `remove`. The set of entities changes through `Commands` alone, which applies the change when the system finishes.

A component added without a value is all zeros, unless it gives `initial`. A number omitted from a value is 0, never `NaN`. `world.set` writes the fields you pass and leaves the others unchanged. Give `initial` to a component whose zeros are wrong, such as a size. It is the value the component has when added bare:

```ts
import { Component, Field } from "arcadekit";
import { World } from "arcadekit/ecs";

const Size = Component.define(
  "game/Size",
  { width: Field.f32, height: Field.f32 },
  { initial: { width: 1, height: 1 } }
);

const world = new World();
world.spawn(Size); // 1 by 1
```

## Require other components

A component can **require** others. A spawn or an add of it gives the entity each one it lacks and wasn't given, bare or with the value written in `requires`:

```ts
import { Component, Field, Transform3d } from "arcadekit";
import { World } from "arcadekit/ecs";

const Rock = Component.define(
  "game/Rock",
  { hp: Field.i32 },
  {
    requires: [
      Transform3d.Position,
      Transform3d.Scale.of({ x: 2, y: 2, z: 2 }),
    ],
  }
);

const world = new World();
world.spawn(Rock); // at the origin, twice its size
world.spawn(Rock, Transform3d.Position.of({ x: 4, y: 0, z: 0 })); // at 4
```

- What a required component requires is filled in too. Of two values for one component, the one given at the spawn wins, then one written in `requires` over one it inherits, then the later.
- Adding a component the entity already has fills in what it has lost since. Removing a required component is allowed, and leaves the rock without it.
- `Commands.spawns(Rock)` names what `Rock` requires too, so a system that watches positions is [ordered](systems.md#order-systems) after one that spawns rocks.
- A relation can't be required, since there is no target to fill in, and neither can a singleton.
- A save holds components and not the rule, so loading one fills nothing in. A replay recorded before a component required something spawns it without, and [drifts](replays.md) from a game that fills it in.

## Use a tag or sparse storage

A **tag** is a component with no fields. Store a component sparsely when it is added and removed often, or when few entities have it. Adding or removing a sparse component doesn't move the entity between tables:

```ts
import { Component, Field, Query } from "arcadekit";

const Health = Component.define("game/Health", { hp: Field.i32 });
const Stunned = Component.tag("game/Stunned", { storage: "sparse" });

const Dazed = Query.all(Health).pipe(Query.with(Stunned));
```

A query requires a tag with `Query.with`, as `Dazed` does. See [queries](queries.md#find-entities-by-their-components).

## Place an entity in space

`Transform3d` provides three components for an entity's place in three dimensions, `Position`, `Rotation` and `Scale`, and `Transform2d` provides the same for flat games. They live in arcadekit rather than in a renderer, so your rules and whatever draws them agree on where things are. See [transforms](transforms.md).

## Read more

- [`Field`](/reference/arcadekit/Field), [`Entity`](/reference/arcadekit/ecs#entity), [`Component`](/reference/arcadekit/ecs#component) and [`Transform3d`](/reference/arcadekit/Transform3d) in the API reference.
