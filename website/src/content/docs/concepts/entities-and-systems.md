---
title: "Entities and systems"
description: "arcadekit is an entity component system (ECS) with Effect around it. This page explains the parts and why the line between Effect code and plain code is where it is."
---

arcadekit is an entity component system (ECS) with Effect around it. This page explains the parts and why the line between Effect code and plain code is where it is.

## The parts

- An **entity** is a number, its id. It has no data of its own.
- A **component** is a kind of data an entity can have: `Position`, `Health`, `Burning`. An entity has any set of components, and gains or loses them as the game goes.
- A **system** is the game's code. It asks for the entities that have some components, with a **query**, and does something to each of them, once per tick.
- A **singleton** is data there is one of per world: the score, whose turn it is.
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

const Moving = Query.all(Position, Velocity);

const Movement = System.make("game/Movement", function* () {
  const { delta } = yield* Time;
  (yield* Moving).each((position, velocity) => {
    position.x += velocity.x * delta;
    position.y += velocity.y * delta;
  });
});
```

## How the world stores them

Entities with the same set of components share a table, and each field of a component is a column of that table: a `Float32Array` for an `f32` field. A query visits the tables that match, row by row. So a loop over a hundred thousand entities reads arrays of numbers in order, which is about as fast as JavaScript goes.

A component that is added and removed often, a tag such as `Stunned`, or that few entities have, can be stored `"sparse"` instead, in a set of its own. Gaining or losing it then doesn't move the entity to another table.

The storage core is `arcadekit/ecs`. It is plain synchronous TypeScript and imports nothing, not even Effect.

## An entity's id

An id is two numbers in one: an index, which is the slot the entity lives in, and above it a generation, which counts how often that slot was given out before. A slot that comes free is given out again with the next generation, so an id that was kept across the reuse names nobody: `isAlive` is false of it, `get` gives nothing, and a [relation](../guides/components.md#relations) that held it is gone.

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
entityIndex(rock); // the slot it lives in
entityGeneration(rock); // how often that slot was given out before
world.despawn(rock);
world.isAlive(rock); // false, now and for good
```

- **An id never names another entity than its own.** The index has 22 bits and the generation 31. A slot that is given out again every tick, as a bullet's is, lasts more than a year at sixty ticks a second, and when its generations are used up it is given out no more.
- A world holds at most 4,194,304 entities at a time, which is what 22 bits of index are. A spawn past that throws.
- An id is a whole number below 2^53. It is a whole number in JSON, in a save and in an action's payload, where [`EntityId`](/reference/arcadekit/Schemas) is its schema.
- An array that holds ids is a `Float64Array`, which holds every such number exactly: a table's `entities`, which `eachChunk` hands out, and the column of a `Field.entity` are. A `Uint32Array` cuts short the id of an entity whose slot was given out more than 1,023 times, and nothing says so.
- `entityIndex` and `entityGeneration`, of `arcadekit/ecs`, read the two halves. A shift sees 32 bits and no more.

## Effect on the outside, plain loops inside

A system is one Effect per tick. Inside it, the loop over entities is a plain function.

- **The system is Effect** because it needs what Effect gives: services (`Time`, `Random`, a game's own), typed errors, and a scheduler the app controls. It runs a handful of times a tick, so what Effect costs doesn't matter.
- **The loop is plain** because it runs once per entity. Measured, an Effect per entity is about 25 times slower than a loop over columns.

So a loop never `yield*`s. A system takes what it needs from its services before the loop, and the loop uses it as a plain value.

## Changing which entities exist

Nothing spawns, despawns, adds or removes a component while a query is iterating: the world throws. A system asks `Commands` for it, and the change is applied when the system is done:

```ts
import { Commands, Component, Field, Query, System, Time } from "arcadekit";

const Lifetime = Component.define("game/Lifetime", { seconds: Field.f32 });
const Mortal = Query.all(Lifetime);

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

Writing a field in place is fine. It is changing the shape of the world that waits.

## Plugins

A feature is a plugin: its systems, its components, the actions it handles, the services it provides and what it does at the start. A plugin names the plugins it depends on, and a game is a plugin of plugins. See [plugins](../guides/plugins.md).

## Names

A string that identifies something at run time carries the name of the feature it belongs to: a component is `"physics/Position"`, a system `"game/Movement"`, an event `"physics/Collided"`. Everything the kit names itself begins with `arcadekit/`, such as the service `"arcadekit/World"` and the system `"arcadekit/Input.Read"`, so a game is free to key a service of its own `"World"`.

## Where this comes from

The design follows [Bevy](https://bevy.org), an ECS built around systems, queries, commands, events, resources and plugins. The interface is written with Effect's idioms rather than translated from Rust.

## Read more

- [Components](../guides/components.md) and [queries](../guides/queries.md) in the guides.
- [Systems](../guides/systems.md): their order, their stages, and saying what they read and write.
- [`Field`](/reference/arcadekit/Field) in the API reference, for every kind of field.
