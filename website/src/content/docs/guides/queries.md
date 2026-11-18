---
title: "Queries"
description: "A query finds the entities that have some components, and hands their data to a loop. This guide covers the two ways to loop, filters, sparse components, saying what a loop only reads, and queries for what changed."
---

A query finds the entities that have some components, and hands their data to a loop. This guide covers the two ways to loop, filters, sparse components, saying what a loop only reads, and queries for what changed.

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

A query is a value, defined once at module level. `yield*` in a system gives a view of it for this tick. `Query.with(Player)` narrows it to the entities that also have a component, without handing out its data, and `Query.without(Frozen)` leaves out the ones that have one.

Both loops below work with every query and visit entities in the same order: tables in the order they were made, rows ascending.

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

Under `noUncheckedIndexedAccess`, reading `position.x[i]` gives `number | undefined`, so each read from a raw column needs the `!`. A project without that compiler option can write `position.x[i] += velocity.x[i] * delta`. `each` needs none, because its accessors return `number`. Nothing of the raw path spares the assertion: a read that checked would be a call per read, and a raw loop is there because it makes none.

## Sparse components in a raw loop

A sparse component used as a query's data is an ordinary accessor in `each`. In `eachChunk` it arrives as `{ columns, indexOf }`, because its rows don't line up with the table's. The last argument of `eachChunk` is the ids of the table's rows:

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

As a filter, `Query.with` or `Query.without`, a sparse component costs a raw loop nothing per row: the table arrives as runs of consecutive rows that match.

## Saying what a loop only reads

`Query.reads(Velocity)` says the loop reads `Velocity` and never writes it. `Query.reads()` with nothing says that of every term.

- `each` hands out an accessor whose fields can't be assigned: the compiler refuses it, and at run time it throws and names the field.
- `eachChunk` types the columns as read-only, and doesn't count their rows as written.
- So a change query watching that component isn't set off by the loop, and a change query may read, raw, what it watches itself.
- In an action's handler, those columns aren't copied for a rollback.
- The compiler tells two components with the same fields apart by their names, which are part of their types: above, `position.x` is written and `velocity.x` is not, though both are `{ x, y }`.

Say it wherever it's true. It is cheaper and it tells the app more. Leaving it out is never wrong, only slower. Saying it and then writing a raw column past the compiler is a bug nothing catches: no change query hears of the write, and no refusal takes it back.

## What changed

A change query visits only the entities something happened to since the system last looked: `Query.changed` for a component that was written, `Query.added` for one that was gained. `Query.removed` gives the ids of the entities that lost one.

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

- Each system has its own place in what changed, and sees every change once, whatever order systems run in. One that was not run misses nothing: what changed meanwhile is there when it runs again.
- An action's handler has a place of its own. Outside a system or a handler (in a script, a test, the entry point) there is one place per query, shared by whoever uses it there.
- The first visit is of every entity that matches: to a query that never ran, everything is new. So a system that builds something for each `added(Sprite)` needs no other code for the entities that were there before it, or that came out of a save.
- An entity is visited once, however often it was written, and in the order any query visits entities in. One that has lost the component since, or was despawned, isn't visited.
- With several components, or with `changed` and `added` together, an entity is visited when any one of them fired.
- `Query.removed` reports once per removal, oldest first, from the first time a reader asks. The id of a despawned entity is no longer alive.
- When nothing changed, a visit costs under 100 ns, whatever the size of the world.

A change query is for what changes now and then. A system that wants every entity every tick uses an ordinary query.

## What counts as a write

- A write is noticed per entity: by `world.set`, by adding a component with a value, and by assigning to a field in `each`. A component an entity has just gained counts as written. Reading notes nothing.
- `eachChunk` hands out raw columns and can't tell a read from a write, so every row it hands out counts as written, unless the query says it only reads that component.
- A write through a raw column that the query said it only reads is written all the same: the compiler does not see it, nothing refuses it, and no change query hears of it.
- For the same reason a change query can't `eachChunk` over a component it watches itself without saying it only reads it: that throws, since the query would take its own visit for a change.
- Only a watched component is noticed. One that no query watches costs nothing more to write.
- A system that writes what it watches sees its own writes the next time it runs.
- A refused action's writes aren't changes: they are taken back with the rest, and so are the visits its handler made.

What a query has yet to visit is saved with a game by `app.save()`, with each system's place in it, so a loaded game reacts to what the saved one hadn't got to yet. It is not in `world.snapshot()` or in the world's hash: it belongs to the readers, and a plugin that only watches doesn't change the hash of the game it watches. With the storage core on its own, `world.saveChanges()` and `world.restoreChanges()` carry it beside a snapshot.

## Counting and listing

`view.count()` counts without visiting: for a change query, it is how many entities the query has yet to visit. `view.entities()` gives the ids, and for a change query is a visit as `each` is. `app.world.view(query)` gives a view outside a system, in a test or a tool.

## Not done yet

Systems don't run on workers. When they do, a sparse component will be only a filter to a loop that runs on one, worked out on the main thread, and not its data. A component common enough for its loop to be worth sharing out between threads is better in a table.

## Read more

- [`Query`](/reference/arcadekit/Query) in the API reference, and what each way to loop costs, in [performance](performance.md).
