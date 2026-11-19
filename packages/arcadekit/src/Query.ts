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

import type { ComponentDef, ReadOnlyTerm } from "./ecs/component";
import type { QuerySpec, QueryView, RemovedReader, Terms } from "./ecs/world";
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
    readonly withDefs: readonly ComponentDef<any>[],
    readonly withoutDefs: readonly ComponentDef<any>[],
    readonly changedDefs: readonly ComponentDef<any>[] = [],
    readonly addedDefs: readonly ComponentDef<any>[] = [],
    readonly readDefs: readonly ComponentDef<any>[] = []
  ) {
    super();
  }

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
 * the loop.
 *
 * @category Constructors
 */
export const all = <const D extends Terms>(...terms: D): Query<D> =>
  new Query(terms, [], []);

/**
 * Narrows a query to entities that also have these components, without
 * reading their data: `Query.all(Position).pipe(Query.with(Player))`.
 *
 * @category Combinators
 */
const with_: {
  (
    ...defs: readonly ComponentDef<any>[]
  ): <D extends Terms>(self: Query<D>) => Query<D>;
  <D extends Terms>(
    self: Query<D>,
    ...defs: readonly ComponentDef<any>[]
  ): Query<D>;
} = dual(
  (args) => args[0] instanceof Query,
  <D extends Terms>(
    self: Query<D>,
    ...defs: readonly ComponentDef<any>[]
  ): Query<D> =>
    new Query(
      self.terms,
      [...self.withDefs, ...defs],
      self.withoutDefs,
      self.changedDefs,
      self.addedDefs,
      self.readDefs
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
    ...defs: readonly ComponentDef<any>[]
  ): <D extends Terms>(self: Query<D>) => Query<D>;
  <D extends Terms>(
    self: Query<D>,
    ...defs: readonly ComponentDef<any>[]
  ): Query<D>;
} = dual(
  (args) => args[0] instanceof Query,
  <D extends Terms>(
    self: Query<D>,
    ...defs: readonly ComponentDef<any>[]
  ): Query<D> =>
    new Query(
      self.terms,
      self.withDefs,
      [...self.withoutDefs, ...defs],
      self.changedDefs,
      self.addedDefs,
      self.readDefs
    )
);

/**
 * Visits only the entities that had one of these components written since the
 * reader last visited. A component an entity has just gained counts as written.
 * The components are required, as with `Query.with`.
 *
 * - Each system, and each action's handler, tracks its own position, and sees
 *   every change once. On its first visit, it sees every matching entity. A
 *   system that was skipped misses nothing: what changed in the meantime is
 *   there when it runs again.
 * - `each`, `eachChunk` and `entities` count as visits. `count` only peeks.
 * - An entity is visited once however often it was written, in the usual query
 *   order. An entity that has since lost the component, or was despawned, isn't
 *   visited.
 * - A write is detected per entity by `world.set`, by adding the component with
 *   a value, and by assigning to a field in `each`. `eachChunk` hands out raw
 *   columns and can't detect writes, so every row it hands out counts as
 *   written, unless the query declares that it only reads the component with
 *   `Query.reads`. Reading records nothing.
 * - Only watched components are tracked: writing a component no query watches
 *   costs nothing extra.
 * - A system that writes what it watches sees its own writes next time.
 * - A refused action's writes aren't changes: they are rolled back with
 *   everything else, as are the visits its handler made.
 * - Outside a system or a handler (in a script, a test, the entry point) there
 *   is one position per query, shared by every caller there.
 * - With several components, or combined with `Query.added`, an entity is
 *   visited when any one of them fired.
 * - `app.save()` saves what a query has yet to visit, with each reader's
 *   position. It isn't part of the world's snapshot or hash.
 *
 * **Gotchas**
 *
 * A change query can't `eachChunk` over a component it watches, and throws: it
 * would mistake its own visit for a change. Iterate with `each`, or declare
 * that the loop only reads the component with `Query.reads`.
 *
 * @category Combinators
 */
export const changed: {
  (
    ...defs: readonly ComponentDef<any>[]
  ): <D extends Terms>(self: Query<D>) => Query<D>;
  <D extends Terms>(
    self: Query<D>,
    ...defs: readonly ComponentDef<any>[]
  ): Query<D>;
} = dual(
  (args) => args[0] instanceof Query,
  <D extends Terms>(
    self: Query<D>,
    ...defs: readonly ComponentDef<any>[]
  ): Query<D> =>
    new Query(
      self.terms,
      self.withDefs,
      self.withoutDefs,
      [...self.changedDefs, ...defs],
      self.addedDefs,
      self.readDefs
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
    ...defs: readonly ComponentDef<any>[]
  ): <D extends Terms>(self: Query<D>) => Query<D>;
  <D extends Terms>(
    self: Query<D>,
    ...defs: readonly ComponentDef<any>[]
  ): Query<D>;
} = dual(
  (args) => args[0] instanceof Query,
  <D extends Terms>(
    self: Query<D>,
    ...defs: readonly ComponentDef<any>[]
  ): Query<D> =>
    new Query(
      self.terms,
      self.withDefs,
      self.withoutDefs,
      self.changedDefs,
      [...self.addedDefs, ...defs],
      self.readDefs
    )
);

/**
 * A query's terms, with the read-only ones marked as such: `R` is the
 * components passed to `Query.reads`, or `never` for all of them. Components
 * are distinguished by name, which is part of their type.
 *
 * @category Type-level
 */
export type Reading<D extends Terms, R> = {
  [K in keyof D]: [R] extends [never]
    ? D[K] & ReadOnlyTerm
    : D[K] extends R
      ? D[K] & ReadOnlyTerm
      : D[K];
} extends infer Marked extends Terms
  ? Marked
  : never;

/**
 * Declares which of a query's terms it only reads, or, given none, that it
 * reads all of them without writing:
 *
 *   const Moving = Query.all(Position, Velocity).pipe(Query.reads(Velocity))
 *   const Drawn = Query.all(Position, Sprite).pipe(Query.reads())
 *
 * - `each` hands out an accessor for such a term whose fields can't be
 *   assigned: the compiler rejects it, and it throws at run time.
 * - `eachChunk` hands out its columns typed as read-only, and doesn't count
 *   their rows as written. So a system that reads a watched component in a raw
 *   loop doesn't trigger the queries that watch it, and a change query can read
 *   what it watches through raw columns.
 * - In an action's handler, its columns aren't copied for a rollback, since
 *   there is nothing to restore.
 *
 * Leaving it out is never wrong, only slower. The declaration is the query's
 * own: raw columns are typed arrays regardless, and a loop that writes one past
 * the compiler has still written it. No change query sees that write, and no
 * refusal rolls it back.
 *
 * Throws when given a component that isn't one of the query's terms: to require
 * a component without its data, use `Query.with`.
 *
 * @category Combinators
 */
export const reads: {
  <const R extends readonly ComponentDef<any>[]>(
    ...defs: R
  ): <D extends Terms>(self: Query<D>) => Query<Reading<D, R[number]>>;
  <D extends Terms, const R extends readonly ComponentDef<any>[]>(
    self: Query<D>,
    ...defs: R
  ): Query<Reading<D, R[number]>>;
} = dual(
  (args) => args[0] instanceof Query,
  <D extends Terms>(
    self: Query<D>,
    ...defs: readonly ComponentDef<any>[]
  ): Query<any> => {
    for (const def of defs) {
      if (!self.terms.includes(def)) {
        throw new Error(
          `Query.reads was given "${def.name}", which is not one of the query's terms: ${self.terms.map((term) => term.name).join(", ") || "it has none"}. A query only reads what it is handed; to require a component without its data, use Query.with.`
        );
      }
    }

    // In the order of the terms, each once.
    const given = defs.length === 0 ? self.terms : defs;

    return new Query(
      self.terms,
      self.withDefs,
      self.withoutDefs,
      self.changedDefs,
      self.addedDefs,
      self.terms.filter(
        (def) => given.includes(def) || self.readDefs.includes(def)
      )
    );
  }
);

/**
 * The entities that lost a component since the reader last read: `(yield*
 * Query.removed(Sprite)).read()` returns their ids, oldest first, once per
 * removal. A despawned entity lost everything it had, and its id is no longer
 * alive. Removals are tracked from the reader's first read, and each system and
 * handler tracks its own position.
 *
 * @category Models
 */
export class Removed extends Effectable.Class<RemovedReader, never, World> {
  private effect: Effect.Effect<RemovedReader, never, World> | undefined;

  constructor(readonly component: ComponentDef<any>) {
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
export const removed = (component: ComponentDef<any>): Removed =>
  new Removed(component);
