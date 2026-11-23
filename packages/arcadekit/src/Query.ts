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
import { World, whole } from "./Services";

/**
 * An immutable query description, independent of any world.
 *
 * It extends `Effectable.Class`, which makes it an Effect: `yield*` works on
 * it, `.pipe()` is available, and the `World` requirement appears in the type
 * of any system that uses it.
 *
 * @category Models
 */
export class Query<D extends Terms, W extends Watching = Watching>
  extends Effectable.Class<QueryView<D>, never, Needs<D, W>>
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

  asEffect(): Effect.Effect<QueryView<D>, never, Needs<D, W>> {
    // Built once and reused: the world caches the view per query, so after
    // the first tick this is a service lookup plus a Map hit. A change
    // query's view is the one of whoever is running: `world.reader`.
    return (this.effect ??= Effect.map(Effect.service(World), (world) =>
      whole(world).view(this)
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
export const all = <const D extends Terms>(
  ...terms: D
): Query<Reading<D>, never> =>
  new Query<Reading<D>, never>(terms as Terms as Reading<D>, [], []);

/**
 * Narrows a query to entities that also have these components, without
 * reading their data: `Query.all(Position).pipe(Query.with(Player))`.
 *
 * @category Combinators
 */
const with_: {
  (
    ...defs: readonly ComponentDef[]
  ): <D extends Terms, W extends Watching>(self: Query<D, W>) => Query<D, W>;
  <D extends Terms, W extends Watching>(
    self: Query<D, W>,
    ...defs: readonly ComponentDef[]
  ): Query<D, W>;
} = dual(
  (args) => args[0] instanceof Query,
  <D extends Terms, W extends Watching>(
    self: Query<D, W>,
    ...defs: readonly ComponentDef[]
  ): Query<D, W> =>
    new Query<D, W>(
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
  ): <D extends Terms, W extends Watching>(self: Query<D, W>) => Query<D, W>;
  <D extends Terms, W extends Watching>(
    self: Query<D, W>,
    ...defs: readonly ComponentDef[]
  ): Query<D, W>;
} = dual(
  (args) => args[0] instanceof Query,
  <D extends Terms, W extends Watching>(
    self: Query<D, W>,
    ...defs: readonly ComponentDef[]
  ): Query<D, W> =>
    new Query<D, W>(
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
 * - Outside a system or a handler (in a test, the entry point) there
 *   is one position per query, shared by every caller there.
 * - With several components, or combined with `Query.added`, an entity is
 *   visited when any one of them fired.
 * - `app.save()` saves what a query has yet to visit, with each reader's
 *   position. It isn't part of the world's snapshot or hash.
 *
 * - A system that watches a component is listed after the systems that write it
 *   in the same tick, with a query, with `World.writes` or by spawning it, or
 *   it would see their writes a tick late. `App.define` and `Plugin.make`
 *   refuse a list the other way round, and the error names the two systems:
 *   see `System.Misordered`.
 *
 * **Gotchas**
 *
 * - A change query can't `eachChunk` over a component it watches and writes,
 *   and throws: it would mistake its own visit for a change. Iterate with
 *   `each`.
 * - Raw columns are typed arrays all the same: a write to one of a term the
 *   query only reads, past the compiler, is seen by no change query and by no
 *   check of the order.
 *
 * @category Combinators
 */
export const changed: {
  <const C extends readonly ComponentDef[]>(
    ...defs: C
  ): <D extends Terms, W extends Watching>(
    self: Query<D, W>
  ) => Query<D, W | WatchesOf<NameOf<C[number]>>>;
  <
    D extends Terms,
    W extends Watching,
    const C extends readonly ComponentDef[],
  >(
    self: Query<D, W>,
    ...defs: C
  ): Query<D, W | WatchesOf<NameOf<C[number]>>>;
} = dual(
  (args) => args[0] instanceof Query,
  <
    D extends Terms,
    W extends Watching,
    const C extends readonly ComponentDef[],
  >(
    self: Query<D, W>,
    ...defs: C
  ): Query<D, W | WatchesOf<NameOf<C[number]>>> =>
    new Query<D, W | WatchesOf<NameOf<C[number]>>>(
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
 * A system that watches for a component is listed after the systems that spawn
 * or add it in the same tick, those that asked for it with `Commands.spawns`,
 * or it would see the entities a tick late. `App.define` and `Plugin.make`
 * refuse a list the other way round: see `System.Misordered`.
 *
 * @category Combinators
 */
export const added: {
  <const C extends readonly ComponentDef[]>(
    ...defs: C
  ): <D extends Terms, W extends Watching>(
    self: Query<D, W>
  ) => Query<D, W | WatchesAddedOf<NameOf<C[number]>>>;
  <
    D extends Terms,
    W extends Watching,
    const C extends readonly ComponentDef[],
  >(
    self: Query<D, W>,
    ...defs: C
  ): Query<D, W | WatchesAddedOf<NameOf<C[number]>>>;
} = dual(
  (args) => args[0] instanceof Query,
  <
    D extends Terms,
    W extends Watching,
    const C extends readonly ComponentDef[],
  >(
    self: Query<D, W>,
    ...defs: C
  ): Query<D, W | WatchesAddedOf<NameOf<C[number]>>> =>
    new Query<D, W | WatchesAddedOf<NameOf<C[number]>>>(
      self.terms,
      self.withDefs,
      self.withoutDefs,
      self.changedDefs,
      [...self.addedDefs, ...defs],
      self.writeDefs
    )
);

/**
 * In a system's requirements, says that it writes the component named `N`: it
 * yields a query that names the component with `Query.writes`. Nobody writes
 * this type or provides it. A system's type holds it, and `App.define` and
 * `Plugin.make` read it there to check the order of the list.
 *
 * @category Type-level
 */
export interface Writes<out N extends string> {
  readonly "~arcadekit/Query/Writes": N;
}

/**
 * In a system's requirements, says that it watches the component named `N` for
 * writes: it yields a query made with `Query.changed`. As with `Writes`, nobody
 * writes this type or provides it.
 *
 * @category Type-level
 */
export interface Watches<out N extends string> {
  readonly "~arcadekit/Query/Watches": N;
}

/**
 * In a system's requirements, says that it watches the component named `N` for
 * entities that gain it: it yields a query made with `Query.added`. As with
 * `Writes`, nobody writes this type or provides it.
 *
 * @category Type-level
 */
export interface WatchesAdded<out N extends string> {
  readonly "~arcadekit/Query/WatchesAdded": N;
}

/**
 * In a system's requirements, says that it gives entities the component named
 * `N`, by spawning them with it or adding it: it asked for its commands with
 * `Commands.spawns`. As with `Writes`, nobody writes this type or provides it.
 *
 * @category Type-level
 */
export interface Adds<out N extends string> {
  readonly "~arcadekit/Query/Adds": N;
}

/**
 * What a query watches for, as its type has it: a `Watches` for each component
 * given to `Query.changed` and a `WatchesAdded` for each given to
 * `Query.added`.
 *
 * @category Type-level
 */
export type Watching = Watches<string> | WatchesAdded<string>;

/**
 * What a system's requirements say of what it writes, adds and watches, beside
 * its services. An app provides them, since they stand for nothing at run time.
 *
 * @category Type-level
 */
export type Access = Writes<string> | Adds<string> | Watching;

/**
 * The name of a component, as its definition's type has it, or as the type of
 * its value has it.
 *
 * @category Type-level
 */
export type NameOf<T> = T extends { readonly def: { readonly name: infer N } }
  ? N & string
  : T extends { readonly name: infer N extends string }
    ? N
    : never;

// Distributive on purpose: no name gives `never`, not a `Writes` of nothing.
/**
 * A `Writes` for each name of a union, and `never` for none.
 *
 * @category Type-level
 */
export type WritesOf<N extends string> = N extends string ? Writes<N> : never;
type WatchesOf<N extends string> = N extends string ? Watches<N> : never;
type WatchesAddedOf<N extends string> = N extends string
  ? WatchesAdded<N>
  : never;
/**
 * An `Adds` for each name of a union, and `never` for none.
 *
 * @category Type-level
 */
export type AddsOf<N extends string> = N extends string ? Adds<N> : never;

/** The names of the terms a query writes: those not marked as read-only. */
type Written<D extends Terms> = {
  [K in keyof D]: D[K] extends ReadOnlyTerm ? never : NameOf<D[K]>;
}[number];

/**
 * What yielding a query requires: the world, and what the query writes and
 * watches, which is how a system's type comes to say it.
 *
 * @category Type-level
 */
export type Needs<D extends Terms, W extends Watching = never> =
  | World
  | WritesOf<Written<D>>
  | W;

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
  ): <D extends Terms, Wa extends Watching>(
    self: Query<D, Wa>
  ) => Query<Writing<D, W[number]>, Wa>;
  <
    D extends Terms,
    Wa extends Watching,
    const W extends readonly [ComponentDef, ...ComponentDef[]],
  >(
    self: Query<D, Wa>,
    ...defs: W
  ): Query<Writing<D, W[number]>, Wa>;
} = dual(
  (args) => args[0] instanceof Query,
  <
    D extends Terms,
    Wa extends Watching,
    const W extends readonly [ComponentDef, ...ComponentDef[]],
  >(
    self: Query<D, Wa>,
    ...defs: W
  ): Query<Writing<D, W[number]>, Wa> => {
    for (const def of defs) {
      if (!self.terms.includes(def)) {
        throw new Error(
          `Query.writes was given "${def.name}", which is not one of the query's terms: ${self.terms.map((term) => term.name).join(", ") || "it has none"}. A query writes only what it is handed: add it to Query.all.`
        );
      }
    }
    return new Query<Writing<D, W[number]>, Wa>(
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
 * handler tracks its own position.
 *
 * **Gotchas**
 *
 * The order of a list is not checked for removals, as it is for
 * `Query.changed` and `Query.added`: a despawn doesn't say which components its
 * entity had. A system that reads removals, listed ahead of the system that
 * despawns or removes, reads them a tick late. List it after.
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
      whole(world).removed(this.component)
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
