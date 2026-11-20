---
title: "Entities and systems"
description: "arcadekit is an entity component system (ECS) with Effect around it. Learn its parts, how the world stores them, and where Effect code ends and plain code begins."
---

arcadekit is an **entity component system** (ECS) with Effect around it. This page introduces its parts, explains how the world stores them, and shows where Effect code ends and plain code begins.

## The parts

- An **entity** is a number, its id. It has no data of its own.
- A **component** is a kind of data an entity can have: `Position`, `Health`, `Burning`. An entity can have any set of components, and gains or loses them as the game runs.
- A **system** is your game's logic. It uses a **query** to find the entities that have certain components, and processes each of them once per tick.
- A **singleton** is data that exists once per world: the score, whose turn it is.
- The **world** holds all of it.

```ts
import { Component, Field, Query, System, Time } from "arcadekit";

const Position = Component.define("game/Position", {
  x: Field.f32,
  y: Field.f32,
});
const Velocity = Component.define("game/Velocity", {
  x: Field.f32,
  y: Field.f32,
});

const Moving = Query.all(Position, Velocity).pipe(Query.writes(Position));

const Movement = System.make("game/Movement", function* () {
  const { delta } = yield* Time;
  (yield* Moving).each((position, velocity) => {
    position.x += velocity.x * delta;
    position.y += velocity.y * delta;
  });
});
```

A query only reads its components, unless it names the ones it writes with `Query.writes`: here `Moving` writes `Position` and reads `Velocity`, and the compiler refuses an assignment to `velocity.x`. See [queries](../guides/queries.md#what-a-query-writes).

## How the world stores data

Entities with the same set of components share a table, and each field of a component is a column of that table: a `Float32Array` for an `f32` field. A query visits the matching tables row by row. A loop over a hundred thousand entities therefore reads arrays of numbers in order, which is about as fast as JavaScript gets.

A component that is added and removed often, such as a `Stunned` tag, or that few entities have, can use `"sparse"` storage instead, in a set of its own. Adding or removing it then doesn't move the entity to another table.

The storage core is `arcadekit/ecs`. It is plain synchronous TypeScript with no imports, not even Effect.

## Entity ids

An id packs two numbers: an **index**, the slot the entity occupies, and a **generation**, which counts how many times that slot was used before. When a slot is freed and reused, the new entity gets the next generation. An id kept from before the reuse refers to no entity: `isAlive` returns false, `get` returns nothing, and any [relation](../guides/components.md#relations) that held it is removed.

```ts
import {
  Component,
  entityGeneration,
  entityIndex,
  Field,
  World,
} from "arcadekit/ecs";

const Position = Component.define("game/Position", {
  x: Field.f32,
  y: Field.f32,
});

const world = new World();
const rock = world.spawn(Position.of({ x: 0, y: 0 }));
entityIndex(rock); // the slot it occupies
entityGeneration(rock); // how many times that slot was used before
world.despawn(rock);
world.isAlive(rock); // false, permanently
```

- **An id never refers to another entity.** The index has 22 bits and the generation 31. A slot reused every tick, as a bullet's is, lasts more than a year at sixty ticks a second, and is retired once its generations run out.
- A world holds at most 4,194,304 entities at a time, the range of a 22-bit index. Spawning past that throws.
- An id is an integer below 2^53. It is an integer in JSON, in a save and in an action's payload, where [`EntityId`](/reference/arcadekit/Schemas) is its schema.
- Arrays of ids are `Float64Array`s, which hold every id exactly: a table's `entities`, which `eachChunk` passes to your loop, and the column of a `Field.entity`. A `Uint32Array` silently truncates the id of an entity whose slot was reused more than 1,023 times.
- `entityIndex` and `entityGeneration`, from `arcadekit/ecs`, read the two parts. Bitwise operators see only 32 bits.

## Effect outside, plain loops inside

A system is one Effect per tick, and the loop over entities inside it is a plain function.

- **The system is an Effect** because it needs what Effect provides: services (`Time`, `Random`, your own), typed errors, and a scheduler the app controls. It runs a handful of times per tick, so Effect's overhead doesn't matter.
- **The loop is plain** because it runs once per entity. An Effect per entity measures about 25 times slower than a loop over columns.

So a loop never uses `yield*`. A system takes what it needs from its services before the loop, and the loop uses it as a plain value.

## Spawning and despawning

The world throws if anything spawns, despawns, adds or removes a component while a query is iterating. A system uses `Commands` instead, which applies the change when the system finishes:

```ts
import { Commands, Component, Field, Query, System, Time } from "arcadekit";

const Lifetime = Component.define("game/Lifetime", { seconds: Field.f32 });
const Mortal = Query.all(Lifetime).pipe(Query.writes(Lifetime));

const Expiry = System.make("game/Expiry", function* () {
  const commands = yield* Commands;
  const { delta } = yield* Time;
  (yield* Mortal).each((life, entity) => {
    life.seconds -= delta;
    if (life.seconds <= 0) {
      commands.despawn(entity);
    }
  });
});
```

Writing a field in place is always fine. Only changes to the shape of the world are deferred.

## Plugins

Each feature is a **plugin**: its systems, the actions it handles, the services it provides, and its startup logic. A plugin lists the plugins it depends on, and a game is a plugin made of plugins. See [plugins](../guides/plugins.md).

## Naming

Every string that identifies something at run time starts with the name of the feature it belongs to: a component is `"physics/Position"`, a system `"game/Movement"`, an event `"physics/Collided"`. Everything arcadekit names itself starts with `arcadekit/`, such as the service `"arcadekit/World"` and the system `"arcadekit/Input.Read"`, so your game is free to name its own service `"World"`.

## Inspiration

The design follows [Bevy](https://bevy.org), an ECS built around systems, queries, commands, events, resources and plugins. The API is written in Effect's idioms rather than translated from Rust.

## Read more

- [Components](../guides/components.md) and [queries](../guides/queries.md) in the guides.
- [Systems](../guides/systems.md): ordering, stages, and declaring what a system reads and writes.
- [`Field`](/reference/arcadekit/Field) in the API reference, for every field type.
