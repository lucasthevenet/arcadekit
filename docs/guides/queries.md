# Queries

A query finds the entities that have some components, and hands their data to a loop. This guide covers the two ways to loop, filters, saying what a loop only reads, and queries for what changed.

## Asking for entities

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
const Frozen = Component.tag("game/Frozen", { storage: "sparse" });

const Moving = Query.all(Position, Velocity).pipe(Query.without(Frozen));

const Movement = System.make("game/Movement", function* () {
  const { delta } = yield* Time;
  (yield* Moving).each((position, velocity, entity) => {
    position.x += velocity.x * delta;
  });
});
```

A query is a value, defined once at module level. `yield*` in a system gives a view of it for this tick. Both loops below visit entities in the same order: tables in the order they were made, rows ascending.

## Two ways to loop

`each` calls a function per entity, with an accessor for each component whose fields read and write the columns. It is the default.

`eachChunk` hands out the raw columns and a range of rows. It is for the systems where speed counts: about three times faster than `each`.

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
const Moving = Query.all(Position, Velocity).pipe(Query.reads(Velocity));

const Movement = System.make("game/Movement", function* () {
  const { delta } = yield* Time;
  (yield* Moving).eachChunk((start, end, position, velocity) => {
    for (let i = start; i < end; i++) {
      position.x[i] = position.x[i]! + velocity.x[i]! * delta;
    }
  });
});
```

The `!` is there because the repository compiles with `noUncheckedIndexedAccess`. A project without that option can write `position.x[i] += velocity.x[i] * delta`.

A sparse component used as data arrives in `eachChunk` as `{ columns, indexOf }`, because its rows don't line up with the table's. As a filter (`Query.without(Frozen)`) it costs a raw loop nothing per row: the table arrives as runs of rows that match.

## Saying what a loop only reads

`Query.reads(Velocity)` says the loop reads `Velocity` and never writes it. `Query.reads()` with nothing says that of every term.

- `each` hands out an accessor whose fields can't be assigned: the compiler refuses it.
- `eachChunk` types the columns as read-only.
- A change query watching that component isn't set off by the loop.
- In an action's handler, those columns aren't copied for a rollback.

Say it wherever it's true. It is cheaper and it tells the app more.

## What changed

A change query visits only the entities something happened to since the system last looked.

```ts
import { Component, Field, Query, System } from "arcadekit";

const Position = Component.define("game/Position", {
  x: Field.f32,
  y: Field.f32,
});
const Sprite = Component.define("game/Sprite", { frame: Field.u16 });

const Born = Query.all(Sprite).pipe(Query.added(Sprite));
const Moved = Query.all(Position, Sprite).pipe(Query.changed(Position));
const Gone = Query.removed(Sprite);

const Track = System.make("game/Track", function* () {
  (yield* Born).each((sprite, entity) => {}); // gained a Sprite since last time
  (yield* Moved).each((position, sprite) => {}); // had its Position written since
  for (const entity of (yield* Gone).read()) {
  } // lost its Sprite, or was despawned
});
```

- Each system has its own place in what changed, and sees every change once, whatever order systems run in.
- The first visit is of every entity that matches: to a query that never ran, everything is new. Entities loaded from a save count too.
- A write is noticed per entity, by `world.set`, by adding a component with a value, or by assigning a field in `each`. Every row `eachChunk` hands out counts as written, unless the query says it only reads that component.
- When nothing changed, a visit costs under 100 ns, whatever the size of the world.

A change query is for what changes now and then. A system that wants every entity every tick uses an ordinary query.

## Counting and listing

`view.count()` counts without visiting. `view.entities()` gives the ids. `app.world.view(query)` gives a view outside a system, in a test or a tool.

## Read more

- [Change queries](../../packages/arcadekit/README.md#change-queries), [two ways to loop](../../packages/arcadekit/README.md#two-ways-to-loop) and [the benchmark](../../packages/arcadekit/README.md#benchmark-100000-entities-pos--vel--dt) in the reference.
