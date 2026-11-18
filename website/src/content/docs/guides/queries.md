---
title: "Queries"
description: "A query finds the entities that have certain components and passes their data to a loop. Learn the two ways to loop, filters, sparse components, read-only access, and change detection."
---

A **query** finds the entities that have certain components and passes their data to a loop. This guide covers the two ways to loop, filters, sparse components, declaring read-only access, and queries for what changed.

## Querying entities

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

A query is a value, defined once at module level. In a system, `yield*` gives you a view of it for the current tick. `Query.with(Player)` narrows a query to entities that also have a component, without passing its data to the loop, and `Query.without(Frozen)` excludes entities that have one.

Both loops below work with every query and visit entities in the same order: tables in creation order, rows ascending.

## Two ways to loop

`each` calls a function once per entity, with an accessor for each component whose fields read and write the columns. Use it by default.

`eachChunk` passes the raw columns and a range of rows. It is about three times faster than `each`, for systems where speed matters.

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

Under `noUncheckedIndexedAccess`, reading `position.x[i]` has the type `number | undefined`, so each read from a raw column needs a `!`. Without that compiler option you can write `position.x[i] += velocity.x[i] * delta`. `each` needs no assertions, because its accessors return `number`. The raw path has no checked alternative: a checked read would be a function call, and a raw loop exists to avoid one.

## Sparse components in a raw loop

A sparse component used as query data is an ordinary accessor in `each`. In `eachChunk` it arrives as `{ columns, indexOf }`, because its rows don't line up with the table's. The last argument of `eachChunk` holds the ids of the table's rows:

```ts
import { Component, Field, Query, System, Time } from "arcadekit";

const Position = Component.define("game/Position", {
  x: Field.f32,
  y: Field.f32,
});
const Burning = Component.define(
  "game/Burning",
  { seconds: Field.f32 },
  { storage: "sparse" }
);
const OnFire = Query.all(Position, Burning).pipe(Query.reads(Position));

const Burn = System.make("game/Burn", function* () {
  const { delta } = yield* Time;
  (yield* OnFire).eachChunk((start, end, position, burning, entities) => {
    for (let i = start; i < end; i++) {
      burning.columns.seconds[burning.indexOf(entities[i]!)]! -= delta;
    }
  });
});
```

Used as a filter, with `Query.with` or `Query.without`, a sparse component adds no per-row cost to a raw loop: the table arrives as runs of consecutive matching rows.

## Read-only access

`Query.reads(Velocity)` declares that the loop reads `Velocity` and never writes it. `Query.reads()` with no arguments declares that for every term.

- `each` passes an accessor whose fields can't be assigned: the compiler rejects an assignment, and at run time it throws and names the field.
- `eachChunk` types the columns as read-only and doesn't mark their rows as written.
- A change query watching that component isn't triggered by the loop, and a change query can read, raw, the component it watches.
- In an action handler, those columns aren't copied for rollback.
- The compiler tells apart two components with the same fields by their names, which are part of their types: above, `position.x` is writable and `velocity.x` is not, although both are `{ x, y }`.

Declare it wherever it's true: it's cheaper, and it tells the app more. Omitting it is never wrong, only slower. Declaring it and then writing a raw column anyway is a bug nothing catches: no change query sees the write, and no refusal undoes it.

## Change detection

A **change query** visits only the entities something happened to since the system last ran it: `Query.changed` for a component that was written, `Query.added` for one that was added. `Query.removed` returns the ids of the entities that lost one.

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
  (yield* Born).each((sprite, entity) => {}); // added a Sprite since last run
  (yield* Moved).each((position, sprite) => {}); // had its Position written since
  for (const entity of (yield* Gone).read()) {
  } // lost its Sprite, or was despawned
});
```

- Each system tracks its own position in the stream of changes, and sees every change once, whatever order systems run in. A system that didn't run misses nothing: the changes are waiting the next time it runs.
- Each action handler has its own position too. Outside systems and handlers (in a script, a test, the entry point) there is one position per query, shared by every caller there.
- The first run visits every matching entity: to a query that never ran, everything is new. A system that builds something for each `added(Sprite)` therefore also covers entities that existed before it, or that came from a save, with no extra code.
- An entity is visited once, however many times it was written, in the usual query order. An entity that has since lost the component, or been despawned, isn't visited.
- With several components, or `changed` and `added` together, an entity is visited when any of them fired.
- `Query.removed` reports each removal once, oldest first, starting from the first time a reader asks. The id of a despawned entity is no longer alive.
- When nothing changed, a visit costs under 100 ns, whatever the size of the world.

Change queries are for data that changes occasionally. A system that processes every entity every tick uses an ordinary query.

## What counts as a write

- Writes are tracked per entity: by `world.set`, by adding a component with a value, and by assigning a field in `each`. A newly added component counts as written. Reading tracks nothing.
- `eachChunk` passes raw columns and can't tell reads from writes, so every row it passes counts as written, unless the query declares that component read-only.
- A write through a raw column the query declared read-only still happens: the compiler doesn't see it, nothing refuses it, and no change query sees it.
- For the same reason, a change query can't `eachChunk` over a component it watches unless it declares it read-only: that throws, because the query would count its own visit as a change.
- Only watched components are tracked. Writing a component no query watches costs nothing extra.
- A system that writes what it watches sees its own writes the next time it runs.
- A refused action's writes aren't changes: they are rolled back with everything else, along with the visits its handler made.

`app.save()` saves what change queries haven't visited, along with each system's position, so a loaded game reacts to the changes the saved one hadn't processed. This isn't part of `world.snapshot()` or the world's hash: it belongs to the readers, so a plugin that only watches doesn't change the hash of the game it observes. With the storage core alone, `world.saveChanges()` and `world.restoreChanges()` carry it alongside a snapshot.

## Counting and listing

`view.count()` counts without visiting; for a change query, it is the number of entities it has left to visit. `view.entities()` returns the ids, and for a change query counts as a visit, like `each`. `app.world.view(query)` gives you a view outside a system, in a test or a tool.

## Read more

- [`Query`](/reference/arcadekit/Query) in the API reference, and the cost of each loop in [performance](performance.md).
