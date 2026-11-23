---
title: "Queries"
description: "A query finds the entities that have certain components and passes their data to a loop. Learn the two ways to loop, filters, sparse components, what a query writes, and change detection."
---

A **query** finds the entities that have certain components and passes their data to a loop.

## Find entities by their components

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

A query is a value, defined once at module level. In a system, `yield*` gives you a view of it for the current tick. `Query.with(Player)` narrows a query to entities that also have a component, without passing its data to the loop. `Query.without(Frozen)` excludes entities that have a component.

Both loops below work with every query, and visit entities in the same order: tables in the order they were created, and rows in ascending order.

## Choose how to loop

`each` calls a function once per entity, with an accessor for each component whose fields read and write the columns. Use it by default.

`eachChunk` passes the raw columns and a range of rows. It is three to four times faster than `each`. Use it for the few systems where speed matters.

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

Under `noUncheckedIndexedAccess`, reading `position.x[i]` has the type `number | undefined`, so each read from a raw column needs a `!`. Without that compiler option, you can write `position.x[i] += velocity.x[i] * delta`. `each` needs no assertions, because its accessors return `number`. The raw path has no checked alternative.

## Read a sparse component in a raw loop

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

Used as a filter, with `Query.with` or `Query.without`, a sparse component needs no lookup in a raw loop. `eachChunk` is called once for each run of consecutive matching rows. A filter that splits a table into many short runs slows the loop. See [performance](performance.md).

## Name what a query writes

A query only reads its terms. `Query.writes(Position)` names the ones it writes, as in `Moving` above. It takes only the query's terms, and another component doesn't compile. To require a component without its data, use `Query.with`.

- For a term the query doesn't write, `each` passes an accessor whose fields can't be assigned. The compiler rejects an assignment, and at run time it throws and names the field.
- `eachChunk` types the columns of such a term as read-only, and doesn't mark their rows as written. The rows of a term it writes all count as written, because raw columns can't tell a read from a write.
- A loop that only reads a component doesn't trigger a change query that watches it. A change query can read the component it watches with `eachChunk`. A change query that also writes that component has no `eachChunk`, because the query would see its own visit as a change. Visit it with `each`.
- In an action handler, the app copies the columns of what the query writes for rollback, and no others.
- The compiler tells two components with the same fields apart by their names, which are part of their types. Above, `position.x` is writable and `velocity.x` is not, although both are `{ x, y }`.

A write forced past the compiler into the raw column of a term the query only reads, or into a relation's `target`, is seen by no change query, and no refusal undoes it. An app made with `App.make(game, { verifyFrames: true })` refuses it: `eachChunk` copies each column it hands out read-only, compares it when the loop returns, puts it back if it changed, and throws with the component and field it names. Use it in [tests](testing.md#run-the-frame-stage-by-hand).

## Visit only what changed

A **change query** visits only the entities that something happened to since the system last ran it. `Query.changed` visits the entities whose component was written, and `Query.added` those that gained it. `Query.removed` returns the ids of the entities that lost it.

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

- Each system keeps its own position in the stream of changes, and sees every change once, whatever order systems run in. A system that a condition [turned off](systems.md#run-a-system-only-when-a-condition-holds) sees nothing that changed while it was off.
- List a system that watches a component after the systems that write it in the same tick. The other order [doesn't compile](systems.md#order-systems), because the watcher would react a tick late.
- Each action handler and each plugin's `setup` has its own position too. With the storage core alone, outside an app, every caller shares one position per query.
- The first run visits every matching entity, because to a query that never ran, everything is new. A system that builds something for each entity `Query.added(Sprite)` visits therefore also covers the entities that existed before it, or that came from a save.
- An entity is visited once, however many times it was written, in the usual query order. An entity that has since lost the component, or been despawned, isn't visited.
- With several components, or `changed` and `added` together, an entity is visited when any of them applies.
- `Query.removed` reports each removal once, oldest first, starting from the first time a reader asks. The id of a despawned entity is no longer alive.
- When nothing changed, a visit costs under 100 ns, whatever the size of the world.

Use a change query for data that changes occasionally. For a system that visits every entity every tick, use an ordinary query.

### Trigger a change query with a write

- Writes are tracked per entity: by `world.set`, by adding a component with a value, and by assigning a field in `each`. A newly added component counts as written. Reading tracks nothing.
- Every row that `eachChunk` passes of a term the query writes counts as written.
- Only watched components are tracked. Writing a component no query watches costs nothing extra.
- A system that writes what it watches sees its own writes the next time it runs.
- A refused action's writes aren't changes. They are rolled back with everything else, along with the visits its handler made.

### Keep unvisited changes across a save

`app.save()` saves what change queries haven't visited, along with each system's position. A loaded game therefore reacts to the changes the saved one hadn't visited. `world.snapshot()` and the world's hash don't include them, because they belong to the readers, not the world. A plugin that only watches therefore doesn't change the hash of the game it observes. With the storage core alone, `world.saveChanges()` and `world.restoreChanges()` carry them beside a snapshot.

## Count and list entities

`view.count()` counts the matching entities without visiting them. For a change query, it is the number of entities left to visit. `view.entities()` returns the ids, and for a change query counts as a visit, like `each`.

Outside a system, such as in a test or a tool, `yield* app.read(query)` gives you a view of a query that only reads. A query with `Query.writes`, `Query.changed` or `Query.added` doesn't compile there, and neither does `Query.removed`, because what they write and visit belongs to the game.

## Read more

- [`Query`](/reference/arcadekit/Query) in the API reference, and the cost of each loop in [performance](performance.md).
