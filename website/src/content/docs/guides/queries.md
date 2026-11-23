---
title: "Queries"
description: "A query finds the entities that have certain components and passes their data to a loop. Learn the two ways to loop, filters, sparse components, what a query writes, and change detection."
---

A **query** finds the entities that have certain components and passes their data to a loop. This guide covers the two ways to loop, filters, sparse components, what a query writes, and queries for what changed.

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

const Moving = Query.all(Position, Velocity).pipe(
  Query.without(Frozen),
  Query.writes(Position)
);

const Movement = System.tick("game/Movement", function* () {
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
const Moving = Query.all(Position, Velocity).pipe(Query.writes(Position));

const Movement = System.tick("game/Movement", function* () {
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
const OnFire = Query.all(Position, Burning).pipe(Query.writes(Burning));

const Burn = System.tick("game/Burn", function* () {
  const { delta } = yield* Time;
  (yield* OnFire).eachChunk((start, end, position, burning, entities) => {
    for (let i = start; i < end; i++) {
      burning.columns.seconds[burning.indexOf(entities[i]!)]! -= delta;
    }
  });
});
```

Used as a filter, with `Query.with` or `Query.without`, a sparse component adds no per-row cost to a raw loop: the table arrives as runs of consecutive matching rows.

## What a query writes

A query only reads its terms. `Query.writes(Position)` names the ones it writes, as in `Moving` above:

- `each` passes an accessor whose fields can't be assigned for a term the query doesn't write: the compiler rejects an assignment, and at run time it throws and names the field.
- `eachChunk` types the columns of such a term as read-only, and doesn't mark their rows as written. The rows of a term it writes all count as written, since raw columns can't tell a read from a write.
- A change query watching a component isn't triggered by a loop that only reads it, and a change query can read, raw, the component it watches. One that also writes it can't use `eachChunk`, and throws: it would see its own visit as a change.
- In an action handler, only the columns of what the query writes are copied for rollback.
- The compiler tells apart two components with the same fields by their names, which are part of their types: above, `position.x` is writable and `velocity.x` is not, although both are `{ x, y }`.

Writing a raw column of a term the query doesn't name, past the compiler, is a bug nothing catches: no change query sees the write, and no refusal undoes it.

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

const Track = System.tick("game/Track", function* () {
  (yield* Born).each((sprite, entity) => {}); // added a Sprite since last run
  (yield* Moved).each((position, sprite) => {}); // had its Position written since
  for (const entity of (yield* Gone).read()) {
  } // lost its Sprite, or was despawned
});
```

- Each system tracks its own position in the stream of changes, and sees every change once, whatever order systems run in. A system that [`System.runIf`](systems.md#running-conditionally) turned off sees nothing that changed while it was off, as it hears no event from then: when it runs again, it reads what it needs with an ordinary query.
- List a system that watches a component after the systems that write it in the same tick. The other order [doesn't compile](systems.md#ordering), because the watcher would react a tick late.
- Each action handler has its own position too. Outside systems and handlers (in a test, the entry point) there is one position per query, shared by every caller there.
- The first run visits every matching entity: to a query that never ran, everything is new. A system that builds something for each `added(Sprite)` therefore also covers entities that existed before it, or that came from a save, with no extra code.
- An entity is visited once, however many times it was written, in the usual query order. An entity that has since lost the component, or been despawned, isn't visited.
- With several components, or `changed` and `added` together, an entity is visited when any of them fired.
- `Query.removed` reports each removal once, oldest first, starting from the first time a reader asks. The id of a despawned entity is no longer alive.
- When nothing changed, a visit costs under 100 ns, whatever the size of the world.

Change queries are for data that changes occasionally. A system that processes every entity every tick uses an ordinary query.

## What counts as a write

- Writes are tracked per entity: by `world.set`, by adding a component with a value, and by assigning a field in `each`. A newly added component counts as written. Reading tracks nothing.
- `eachChunk` passes raw columns and can't tell reads from writes, so every row it passes of a component the query writes counts as written.
- A write through a raw column of a component the query only reads still happens: the compiler doesn't see it, nothing refuses it, and no change query sees it.
- For the same reason, a change query can't `eachChunk` over a component it watches and writes: that throws, because the query would count its own visit as a change.
- Only watched components are tracked. Writing a component no query watches costs nothing extra.
- A system that writes what it watches sees its own writes the next time it runs.
- A refused action's writes aren't changes: they are rolled back with everything else, along with the visits its handler made.

`app.save()` saves what change queries haven't visited, along with each system's position, so a loaded game reacts to the changes the saved one hadn't processed. This isn't part of `world.snapshot()` or the world's hash: it belongs to the readers, so a plugin that only watches doesn't change the hash of the game it observes. With the storage core alone, `world.saveChanges()` and `world.restoreChanges()` carry it alongside a snapshot.

## Counting and listing

`view.count()` counts without visiting; for a change query, it is the number of entities it has left to visit. `view.entities()` returns the ids, and for a change query counts as a visit, like `each`. `yield* app.read(query)` gives you a view outside a system, in a test or a tool, of a query that only reads: one with `Query.writes`, `Query.changed` or `Query.added`, and `Query.removed`, don't compile there, since what they write and visit belongs to the game.

## Read more

- [`Query`](/reference/arcadekit/Query) in the API reference, and the cost of each loop in [performance](performance.md).
