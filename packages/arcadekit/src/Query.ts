/**
 * Query descriptions that systems yield to iterate over entities:
 *
 *   const Moving = Query.all(Position, Velocity).pipe(Query.without(Stunned))
 *   const moving = yield* Moving
 *
 * A query can ask only for what changed, and then visits nothing else:
 *
 *   const Moved = Query.all(Position, Sprite).pipe(Query.changed(Position))
 *   const Born = Query.all(Sprite).pipe(Query.added(Sprite))
 *   const Gone = Query.removed(Sprite)
 *
 *   (yield* Moved).each((pos, sprite) => { ... })   // written since this system last looked
 *   for (const entity of (yield* Gone).read()) { ... }
 *
 * Each system tracks its own position in what changed, so every system sees
 * every change once, however often it runs.
 */
import { Effect, Effectable } from "effect";
import { dual } from "effect/Function";

import type { RemovedReader } from "./ecs/changes";
import type { ComponentDef, ReadOnlyTerm } from "./ecs/component";
import type { QuerySpec, QueryView, Terms } from "./ecs/query";
import { World } from "./Services";

/**
 * An immutable query description, independent of any world.
 *
 * It extends `Effectable.Class`, which makes it an Effect: `yield*` works on
 * it, `.pipe()` is available, and the `World` requirement appears in the type
 * of any system that uses it.
 *
 * @category Models
 */
export class Query<D extends Terms>
  extends Effectable.Class<QueryView<D>, never, World>
  implements QuerySpec<D>
{
  private effect: Effect.Effect<QueryView<D>, never, World> | undefined;

  constructor(
    readonly terms: D,
    readonly withDefs: readonly ComponentDef[],
    readonly withoutDefs: readonly ComponentDef[],
    readonly changedDefs: readonly ComponentDef[] = [],
    readonly addedDefs: readonly ComponentDef[] = [],
    readonly writeDefs: readonly ComponentDef[] = []
  ) {
    super();
    this.readDefs = terms.filter((def) => !writeDefs.includes(def));
  }

  /** The terms it only reads: every one that `Query.writes` doesn't name. */
  readonly readDefs: readonly ComponentDef[];

  asEffect(): Effect.Effect<QueryView<D>, never, World> {
    // Built once and reused: the world caches the view per query, so after
    // the first tick this is a service lookup plus a Map hit. A change
    // query's view is the one of whoever is running: `world.reader`.
    return (this.effect ??= Effect.map(Effect.service(World), (world) =>
      world.view(this)
    ));
  }
}

/**
 * Matches entities that have all of these components, and passes their data to
 * the loop. It only reads them: name the ones it writes with `Query.writes`.
 *
 *   const Drawn = Query.all(Position, Sprite)
 *   const Moving = Query.all(Position, Velocity).pipe(Query.writes(Position))
 *
 * @category Constructors
 */
export const all = <const D extends Terms>(...terms: D): Query<Reading<D>> =>
  new Query(terms as Terms as Reading<D>, [], []);

/**
 * Narrows a query to entities that also have these components, without
 * reading their data: `Query.all(Position).pipe(Query.with(Player))`.
 *
 * @category Combinators
 */
const with_: {
  (
    ...defs: readonly ComponentDef[]
  ): <D extends Terms>(self: Query<D>) => Query<D>;
  <D extends Terms>(self: Query<D>, ...defs: readonly ComponentDef[]): Query<D>;
} = dual(
  (args) => args[0] instanceof Query,
  <D extends Terms>(
    self: Query<D>,
    ...defs: readonly ComponentDef[]
  ): Query<D> =>
    new Query(
      self.terms,
      [...self.withDefs, ...defs],
      self.withoutDefs,
      self.changedDefs,
      self.addedDefs,
      self.writeDefs
    )
);

export {
  /** Also requires these components, without reading their data. */
  with_ as with,
};

/**
 * Excludes entities that have any of these components.
 *
 * @category Combinators
 */
export const without: {
  (
    ...defs: readonly ComponentDef[]
  ): <D extends Terms>(self: Query<D>) => Query<D>;
  <D extends Terms>(self: Query<D>, ...defs: readonly ComponentDef[]): Query<D>;
} = dual(
  (args) => args[0] instanceof Query,
  <D extends Terms>(
    self: Query<D>,
    ...defs: readonly ComponentDef[]
  ): Query<D> =>
    new Query(
      self.terms,
      self.withDefs,
      [...self.withoutDefs, ...defs],
      self.changedDefs,
      self.addedDefs,
      self.writeDefs
    )
);

/**
 * Visits only the entities that had one of these components written since the
 * reader last visited. A component an entity has just gained counts as written.
 * The components are required, as with `Query.with`.
 *
 * - Each system, and each action's handler, tracks its own position, and sees
 *   every change once. On its first visit, it sees every matching entity. A
 *   system that `System.runIf` turned off sees nothing that changed while it
 *   was off, as it hears no event from then: see `System.runIf`.
 * - `each`, `eachChunk` and `entities` count as visits. `count` only peeks.
 * - An entity is visited once however often it was written, in the usual query
 *   order. An entity that has since lost the component, or was despawned, isn't
 *   visited.
 * - A write is detected per entity by `world.set`, by adding the component with
 *   a value, and by assigning to a field in `each`. `eachChunk` hands out raw
 *   columns and can't detect writes, so every row it hands out of a component
 *   the query writes counts as written (see `Query.writes`). Reading records
 *   nothing.
 * - Only watched components are tracked: writing a component no query watches
 *   costs nothing extra.
 * - A system that writes what it watches sees its own writes next time.
 * - A refused action's writes aren't changes: they are rolled back with
 *   everything else, as are the visits its handler made.
 * - Outside a system or a handler (in a test, the entry point) there is one
 *   reader, shared by every caller there, as there is of an event.
 * - With several components, or combined with `Query.added`, an entity is
 *   visited when any one of them fired.
 * - `app.save()` saves what a query has yet to visit, with each reader's
 *   position. It isn't part of the world's snapshot or hash.
 *
 * **Gotchas**
 *
 * A change query can't `eachChunk` over a component it watches and writes, and
 * throws: it would mistake its own visit for a change. Iterate with `each`.
 *
 * @category Combinators
 */
export const changed: {
  (
    ...defs: readonly ComponentDef[]
  ): <D extends Terms>(self: Query<D>) => Query<D>;
  <D extends Terms>(self: Query<D>, ...defs: readonly ComponentDef[]): Query<D>;
} = dual(
  (args) => args[0] instanceof Query,
  <D extends Terms>(
    self: Query<D>,
    ...defs: readonly ComponentDef[]
  ): Query<D> =>
    new Query(
      self.terms,
      self.withDefs,
      self.withoutDefs,
      [...self.changedDefs, ...defs],
      self.addedDefs,
      self.writeDefs
    )
);

/**
 * Visits only the entities that gained one of these components since the reader
 * last visited, by being spawned with it or by `add`. Otherwise works like
 * `Query.changed`.
 *
 * @category Combinators
 */
export const added: {
  (
    ...defs: readonly ComponentDef[]
  ): <D extends Terms>(self: Query<D>) => Query<D>;
  <D extends Terms>(self: Query<D>, ...defs: readonly ComponentDef[]): Query<D>;
} = dual(
  (args) => args[0] instanceof Query,
  <D extends Terms>(
    self: Query<D>,
    ...defs: readonly ComponentDef[]
  ): Query<D> =>
    new Query(
      self.terms,
      self.withDefs,
      self.withoutDefs,
      self.changedDefs,
      [...self.addedDefs, ...defs],
      self.writeDefs
    )
);

/**
 * A query's terms, each marked as read-only.
 *
 * @category Type-level
 */
export type Reading<D extends Terms> = {
  [K in keyof D]: D[K] & ReadOnlyTerm;
} extends infer Marked extends Terms
  ? Marked
  : never;

/** The one of the components `W` that a marked term `T` was made from. */
type Unmarked<T, W> = W extends unknown ? (T extends W ? W : never) : never;

/**
 * A query's terms, with the ones in `W` no longer read-only. Components are
 * distinguished by name, which is part of their type.
 *
 * @category Type-level
 */
export type Writing<D extends Terms, W> = {
  [K in keyof D]: D[K] extends ReadOnlyTerm
    ? D[K] extends W
      ? Unmarked<D[K], W>
      : D[K]
    : D[K];
} extends infer Marked extends Terms
  ? Marked
  : never;

/**
 * Names the terms a query writes. The others it only reads, which is what a
 * query does with a term unless it is named here:
 *
 *   const Moving = Query.all(Position, Velocity).pipe(Query.writes(Position))
 *
 * - `each` hands out an accessor for a term it only reads whose fields can't be
 *   assigned: the compiler rejects it, and it throws at run time.
 * - `eachChunk` hands out the columns of a term it only reads typed as
 *   read-only, and doesn't count their rows as written. A term it writes counts
 *   every row it hands out as written for the change queries that watch it, as
 *   raw columns can't tell a read from a write.
 * - In an action's handler, only the columns of what it writes are copied for a
 *   rollback.
 *
 * Raw columns are typed arrays all the same, and a loop that writes one past
 * the compiler has still written it: no change query sees that write, and no
 * refusal rolls it back.
 *
 * Throws when given a component that isn't one of the query's terms: to require
 * a component without its data, use `Query.with`.
 *
 * @category Combinators
 */
export const writes: {
  <const W extends readonly [ComponentDef, ...ComponentDef[]]>(
    ...defs: W
  ): <D extends Terms>(self: Query<D>) => Query<Writing<D, W[number]>>;
  <D extends Terms, const W extends readonly [ComponentDef, ...ComponentDef[]]>(
    self: Query<D>,
    ...defs: W
  ): Query<Writing<D, W[number]>>;
} = dual(
  (args) => args[0] instanceof Query,
  <D extends Terms, const W extends readonly [ComponentDef, ...ComponentDef[]]>(
    self: Query<D>,
    ...defs: W
  ): Query<Writing<D, W[number]>> => {
    for (const def of defs) {
      if (!self.terms.includes(def)) {
        throw new Error(
          `Query.writes was given "${def.name}", which is not one of the query's terms: ${self.terms.map((term) => term.name).join(", ") || "it has none"}. A query writes only what it is handed: add it to Query.all.`
        );
      }
    }
    return new Query(
      // The same terms, with the ones it writes unmarked in the type.
      self.terms as Terms as Writing<D, W[number]>,
      self.withDefs,
      self.withoutDefs,
      self.changedDefs,
      self.addedDefs,
      // In the order of the terms, each once.
      self.terms.filter(
        (def) => defs.includes(def) || self.writeDefs.includes(def)
      )
    );
  }
);

/**
 * The entities that lost a component since the reader last read: `(yield*
 * Query.removed(Sprite)).read()` returns their ids, oldest first, once per
 * removal. A despawned entity lost everything it had, and its id is no longer
 * alive. Removals are tracked from the reader's first read, and each system and
 * handler tracks its own position. Outside a system or a handler there is one
 * reader, shared by every caller there, as there is of an event.
 *
 * @category Models
 */
export class Removed extends Effectable.Class<RemovedReader, never, World> {
  private effect: Effect.Effect<RemovedReader, never, World> | undefined;

  constructor(readonly component: ComponentDef) {
    super();
  }

  asEffect(): Effect.Effect<RemovedReader, never, World> {
    return (this.effect ??= Effect.map(Effect.service(World), (world) =>
      world.removed(this.component)
    ));
  }
}

/**
 * Returns the entities that lost a component since this system last asked:
 * `(yield* Query.removed(Burning))`.
 *
 * @category Constructors
 */
export const removed = (component: ComponentDef): Removed =>
  new Removed(component);
