---
title: "Entities and systems"
description: "arcadekit is an entity component system (ECS) with Effect around it. Learn its parts, how the world stores them, and where Effect code ends and plain code begins."
---

An **entity component system** (ECS) keeps a game's data as components of numbered entities, and its logic in systems that loop over them. arcadekit is an ECS with Effect around it. Each system is an Effect, and the loop inside it is plain code.

## The parts

- An **entity** is an id, and has no data of its own.
- A **component** is a kind of data an entity can have, such as `Position`, `Health` or `Burning`. An entity can have any set of components, and gains or loses them as the game runs.
- A **system** is your game's logic. It uses a **query** to find the entities that have certain components, and visits each of them once per tick.
- A **singleton** is data that exists once per world, such as the score or whose turn it is.
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

const Movement = System.tick("game/Movement", function* () {
  const { delta } = yield* Time;
  (yield* Query.View(Moving)).each((position, velocity) => {
    position.x += velocity.x * delta;
    position.y += velocity.y * delta;
  });
});
```

A query only reads its components, unless it names the ones it writes with `Query.writes`. Here `Moving` writes `Position` and reads `Velocity`, so the compiler refuses an assignment to `velocity.x`. See [what a query writes](../guides/queries.md#name-what-a-query-writes).

## Components are stored in columns

Entities with the same set of components share a table, and each field of a component is a column of that table, such as a `Float32Array` for an `f32` field. A query visits the matching tables row by row, so a loop over a hundred thousand entities reads arrays of numbers in order. With `eachChunk`, such a loop takes about a quarter of a millisecond. See [performance](../guides/performance.md).

A component that is added and removed often, such as a `Stunned` tag, or that few entities have, can use `"sparse"` storage instead, in a set of its own. Adding or removing it then doesn't move the entity to another table.

The storage core is `arcadekit/ecs`. It is plain synchronous TypeScript that imports nothing outside itself, not even Effect. Its world's `view` takes a query made with `Query`, from `arcadekit`.

A component's name is a literal the compiler reads, such as `"game/Hero"`. A name it knows only as `string` doesn't compile.

## An id is an index and a generation

An id packs two numbers. The **index** is the slot the entity occupies, and the **generation** counts how many times that slot was used before. When the world frees a slot and reuses it, the new entity gets the next generation. An id kept from before the reuse refers to no entity: `isAlive` returns false, `get` returns nothing, and no [relation](../guides/relations.md) points at it any more.

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

- **An id never refers to another entity.** The index has 22 bits and the generation 31. A slot reused every tick, as a bullet's is, lasts more than a year at sixty ticks a second. Once its generations run out, the world retires it.
- A world holds at most 4,194,304 entities at a time, the range of a 22-bit index. Spawning past that throws.
- An id is an integer below 2^53 when the game runs. It is an integer in JSON, in a save and in an action's payload, where [`EntityId`](/reference/arcadekit/Schemas) is its schema.
- To the compiler an id is not a number. Compare ids with `===` and key a `Map` or a `Set` with them, but no typed array, number field or arithmetic takes one: a `Uint32Array` or a bitwise operator would keep only an id's low 32 bits, and lose the generation of a slot reused more than 1,023 times. Keep an id in a `Field.entity` or a relation.
- `entityIndex` and `entityGeneration`, from `arcadekit/ecs`, read the two parts, as numbers.

## Effect outside, plain loops inside

A system is one Effect per tick, and the loop over entities inside it is a plain function.

- **The system is an Effect** because it needs what Effect provides: services such as `Time`, `Random` and your own, typed errors, and a scheduler the app controls. Each system runs once per tick, so the cost of an Effect is paid once per system, not once per entity.
- **The loop is plain** because it runs once per entity. An Effect per entity measures about 25 times slower than a loop over columns.

A loop therefore never uses `yield*`. A system takes what it needs from its services before the loop, and the loop uses it as a plain value.

## Commands change the world after a system finishes

A system changes which entities exist through `Commands`. `Commands` applies each change when the system finishes, so the world never changes under a running loop:

```ts
import { Commands, Component, Field, Query, System, Time } from "arcadekit";

const Lifetime = Component.define("game/Lifetime", { seconds: Field.f32 });
const Mortal = Query.all(Lifetime).pipe(Query.writes(Lifetime));

const Expiry = System.tick("game/Expiry", function* () {
  const commands = yield* Commands;
  const { delta } = yield* Time;
  (yield* Query.View(Mortal)).each((life, entity) => {
    life.seconds -= delta;
    if (life.seconds <= 0) {
      commands.despawn(entity);
    }
  });
});
```

A loop can always write a field in place. Only a spawn, a despawn, and an added or removed component wait for the system to finish.

## A game is a plugin made of plugins

Each feature is a **plugin**: its systems, the actions it handles, the services it provides, and its startup logic. A plugin lists the plugins it depends on, and a game is a plugin made of plugins. See [plugins](../guides/plugins.md).

## Every name starts with its feature

Every string that identifies something at run time starts with the name of the feature it belongs to. A component is `"physics/Position"`, a system `"game/Movement"`, and an event `"physics/Collided"`. Every name arcadekit gives its own parts starts with `arcadekit/`, such as the service `"arcadekit/Services.World"` and the system `"arcadekit/Input.Read"`. Your game is therefore free to name its own service `"World"`.

## Inspiration

arcadekit's systems, queries, commands, events, resources and plugins follow the design of [Bevy](https://bevy.org).

## Read more

- [Components](../guides/components.md) and [queries](../guides/queries.md) in the guides.
- [Systems](../guides/systems.md), for ordering and stages.
- [`Field`](/reference/arcadekit/Field) in the API reference, for every field type.
