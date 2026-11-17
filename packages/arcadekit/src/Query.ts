/**
 * Query descriptions that can be yielded inside systems:
 *
 *   const Moving = Query.all(Position, Velocity).pipe(Query.without(Stunned))
 *   const moving = yield* Moving
 *
 * A query can ask for what changed, and then visits nothing else:
 *
 *   const Moved = Query.all(Position, Sprite).pipe(Query.changed(Position))
 *   const Born = Query.all(Sprite).pipe(Query.added(Sprite))
 *   const Gone = Query.removed(Sprite)
 *
 *   (yield* Moved).each((pos, sprite) => { ... })   // written since this system last looked
 *   for (const entity of (yield* Gone).read()) { ... }
 *
 * Each system has its own place in what changed, so every system sees every
 * change once, however often it runs.
 */
import { Effect, Effectable } from "effect";
import { dual } from "effect/Function";

import type { ComponentDef, ReadOnlyTerm } from "./ecs/component";
import type { QuerySpec, QueryView, RemovedReader, Terms } from "./ecs/world";
import { World } from "./Services";

/**
 * An immutable, world-independent query description.
 *
 * It extends `Effectable.Class`, which makes it an Effect: `yield*` works on
 * it, `.pipe()` comes for free, and the `World` requirement shows up in the
 * type of any system that uses it.
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
 * Entities that have all of these components; their data is passed to the loop.
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
  /** Also require these components, without reading their data. */
  with_ as with,
};

/**
 * Exclude entities that have any of these components.
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
 * Visit only the entities that had one of these components written since
 * whoever is asking last visited. A component an entity has just gained
 * counts as written. The components are required, as with `Query.with`.
 *
 * - Each system, and each action's handler, has its own place in what
 *   changed, and sees every change once. The first time, it sees every
 *   entity that matches. A system that was not run misses nothing: what
 *   changed meanwhile is there when it runs again.
 * - `each`, `eachChunk` and `entities` are visits. `count` only looks.
 * - A write is noticed per entity by `world.set`, by adding the component
 *   with a value, and by assigning to a field in `each`. `eachChunk` hands
 *   out raw columns and cannot tell, so every row it is handed counts as
 *   written. Reading notes nothing.
 * - A system that writes what it watches sees its own writes the next time.
 * - Outside a system or a handler (in a script, a test, the entry point)
 *   there is one place per query, shared by whoever uses it there.
 * - With several components, or with `Query.added` as well, an entity is
 *   visited when any one of them fired.
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
 * Visit only the entities that gained one of these components since whoever
 * is asking last visited: by being spawned with it, or by `add`. Otherwise
 * as `Query.changed`.
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
 * A query's terms, with the ones it only reads marked as such: `R` is the
 * components `Query.reads` was given, or `never` for all of them. Components
 * are told apart by their names, which are in their types.
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
 * Says which of a query's terms the query only reads, or, given none, that
 * it only reads any of them:
 *
 *   const Moving = Query.all(Position, Velocity).pipe(Query.reads(Velocity))
 *   const Drawn = Query.all(Position, Sprite).pipe(Query.reads())
 *
 * - `each` hands out an accessor for such a term whose fields cannot be
 *   assigned to: the compiler refuses it, and it throws.
 * - `eachChunk` hands out its columns typed as read-only, and does not
 *   count their rows as written. So a system that reads a watched
 *   component in a raw loop does not set off the queries that watch it,
 *   and a change query may read, raw, what it watches itself.
 * - In an action's handler its columns are not copied for a rollback:
 *   there is nothing to put back.
 *
 * The word is the query's own. Raw columns are typed arrays all the same,
 * and a loop that writes one past the compiler has written it: no change
 * query hears of it, and no refusal takes it back.
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
 * The entities that lost a component since whoever is asking last read:
 * `(yield* Query.removed(Sprite)).read()` gives their ids, oldest first,
 * once per removal. An entity that was despawned lost all it had, and its
 * id is no longer alive. Removals are noticed from the first time a reader
 * asks, and each system and handler has its own place in them.
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
 * The entities that lost a component since this system last asked:
 * `(yield* Query.removed(Burning))`.
 *
 * @category Constructors
 */
export const removed = (component: ComponentDef<any>): Removed =>
  new Removed(component);
