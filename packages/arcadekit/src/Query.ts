/**
 * Queries find the entities that have certain components, and pass their data
 * to a system's loop.
 *
 *   const Moving = Query.all(Position, Velocity).pipe(Query.without(Stunned))
 *   const moving = yield* Moving
 *
 * A change query asks only for what changed, and visits nothing else:
 *
 *   const Moved = Query.all(Position, Sprite).pipe(Query.changed(Position))
 *   const Born = Query.all(Sprite).pipe(Query.added(Sprite))
 *   const Gone = Query.removed(Sprite)
 *
 *   (yield* Moved).each((pos, sprite) => { ... })   // written since this system last looked
 *   for (const entity of (yield* Gone).read()) { ... }
 *
 * Each system tracks its own position in what changed, and sees each change
 * once.
 */
import { Effect, Effectable } from "effect";
import { dual } from "effect/Function";

import type { RemovedReader } from "./ecs/changes.ts";
import type {
  ComponentDef,
  MaybeTerm,
  ReadOnlyTerm,
  Schema,
  Storage,
  WatchedTerm,
} from "./ecs/component.ts";
import type { Described, QuerySpec, QueryView, Terms } from "./ecs/query.ts";
import { whole } from "./internal/handed.ts";
import { World } from "./Services.ts";

/**
 * A query, which says what entities to visit and what to do with their
 * components. It is immutable, and belongs to no world.
 *
 * A query is an Effect. `yield*` on it returns a view of the matching
 * entities, and puts `World`, with what the query writes and watches, in the
 * requirements of the system that yields it.
 *
 * @typeParam D its terms, the components it passes to the loop
 * @typeParam W what it watches, from `Query.changed` and `Query.added`
 *
 * @category Models
 */
export class Query<D extends Terms, W extends Watching = Watching>
  extends Effectable.Class<QueryView<D>, never, Needs<D, W>>
  implements QuerySpec<D>
{
  declare readonly [Described]: true;
  private effect: Effect.Effect<QueryView<D>, never, World> | undefined;

  constructor(
    readonly terms: D,
    readonly withDefs: readonly ComponentDef[],
    readonly withoutDefs: readonly ComponentDef[],
    readonly changedDefs: readonly ComponentDef[] = [],
    readonly addedDefs: readonly ComponentDef[] = [],
    readonly writeDefs: readonly ComponentDef[] = [],
    readonly maybeDefs: readonly ComponentDef[] = []
  ) {
    super();
    this.readDefs = terms.filter((def) => !writeDefs.includes(def));
    const watched = [...changedDefs, ...addedDefs].find((def) =>
      maybeDefs.includes(def)
    );
    if (watched !== undefined) {
      throw new Error(
        `Query.changed or Query.added was given "${watched.name}", which the query takes with Query.maybe. A change query requires what it watches: take "${watched.name}" in Query.all without Query.maybe.`
      );
    }
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
 * the loop. The query only reads them, unless `Query.writes` names them. A
 * component given as `Query.maybe(Rotation)` is passed when an entity has it,
 * and `undefined` when it doesn't, and doesn't decide which entities match.
 *
 *   const Drawn = Query.all(Position, Sprite)
 *   const Moving = Query.all(Position, Velocity).pipe(Query.writes(Position))
 *   const Placed = Query.all(Position, Query.maybe(Rotation), Query.maybe(Scale))
 *
 * **Gotchas**
 *
 * A tag has no data to pass, so it is not a term: one given bare doesn't
 * compile, and one the compiler knows only as a `ComponentDef` throws.
 * Require it with `Query.with(Player)`, or take it as `Query.maybe(Player)`
 * to be told whether an entity has it.
 *
 * @category Constructors
 */
export const all = <const D extends readonly (ComponentDef | Maybe)[]>(
  ...terms: { readonly [K in keyof D]: D[K] & Untagged<D[K]> }
): Query<Reading<Unwrapped<D>>, never> => {
  const tag = terms.find(
    (term): term is ComponentDef => !(term instanceof Maybe) && term.isTag
  );
  if (tag !== undefined) {
    throw new Error(
      `Query.all was given "${tag.name}", a tag, which has no data: the loop would be handed an empty row in its place, and every term after it one argument later. Require it with Query.with, or take it as Query.maybe to be told whether an entity has it.`
    );
  }
  return new Query<Reading<Unwrapped<D>>, never>(
    // The components, with the ones an entity may lack marked in the type.
    terms.map((term) =>
      term instanceof Maybe ? term.def : term
    ) as Terms as Reading<Unwrapped<D>>,
    [],
    [],
    [],
    [],
    [],
    terms.flatMap((term) => (term instanceof Maybe ? [term.def] : []))
  );
};

/**
 * What `Query.all` asks of a term: nothing, unless its type says it is a tag,
 * which has no data to pass. One known only as a `ComponentDef` is left to
 * the check at run time.
 *
 * @category Type-level
 */
export type Untagged<T> =
  T extends ComponentDef<infer S, Storage, infer N>
    ? [keyof S] extends [never]
      ? {
          readonly "Query.all passes no data of a tag, so the loop would get an empty row in its place: require it with Query.with, or take it as Query.maybe to be told whether an entity has it": N;
        }
      : unknown
    : unknown;

/**
 * A component that `Query.all` passes to the loop when an entity has it, and
 * `undefined` when it doesn't. `Query.maybe` makes one.
 *
 * @typeParam C the component
 *
 * @category Models
 */
export class Maybe<C extends ComponentDef = ComponentDef> {
  constructor(
    /** The component. */
    readonly def: C
  ) {
    if (def.storage !== "table") {
      throw new Error(
        `Query.maybe was given "${def.name}", a sparse component. Whether an entity has a table component is the same for its whole table, and is checked once per table; a sparse one would be checked once per entity. Take it in Query.all without Query.maybe, or read it with world.get.`
      );
    }
  }
}

/**
 * The terms of `Query.all`, with each `Maybe` replaced by its component,
 * marked as one an entity may lack.
 *
 * @category Type-level
 */
export type Unwrapped<D extends readonly (ComponentDef | Maybe)[]> = {
  [K in keyof D]: D[K] extends Maybe<infer C> ? C & MaybeTerm : D[K];
} extends infer Marked extends Terms
  ? Marked
  : never;

/**
 * Makes a term of `Query.all` that an entity may lack. The loop gets the
 * component's data when the entity has it, and `undefined` when it doesn't.
 *
 *   const Placed = Query.all(Position, Query.maybe(Rotation), Query.maybe(Scale))
 *
 *   (yield* Placed).eachChunk((start, end, position, rotation, scale) => {
 *     if (rotation === undefined) { ... } // no entity of this run has one
 *   })
 *
 * **When to use**
 *
 * Use when a loop handles entities with and without a component, in place of
 * one query for each combination. A query that requires the component, or
 * `Query.without` it, visits only one kind.
 *
 * **Details**
 *
 * - Whether an entity has a component is the same for its whole table, so a
 *   run of `eachChunk` gets the columns or `undefined` for all its rows. The
 *   check is made once per table, never per entity.
 * - `Query.writes` takes it as it takes any term. The loop writes it only
 *   where it was handed, and only those columns are saved for a rollback.
 * - `Query.with` of the same component requires it after all, and
 *   `Query.without` makes it always `undefined`.
 *
 * **Gotchas**
 *
 * - It takes only a component stored in tables. A sparse one doesn't
 *   compile, and one the compiler knows only as a `ComponentDef` throws when
 *   it is sparse.
 * - `Query.changed` and `Query.added` require what they watch, so they don't
 *   take it. Watching it doesn't compile, or throws for a `ComponentDef`.
 * - In `each`, a test of the argument runs once per entity. In a hot loop,
 *   use `eachChunk` and test once per run.
 *
 * @category Constructors
 */
export const maybe = <const C extends ComponentDef>(
  def: C & Tabled<C>
): Maybe<C> => new Maybe(def);

/**
 * What `Query.maybe` asks of the component it is given: nothing, unless its
 * type says it is sparse. One known only as a `ComponentDef` is left to the
 * check at run time.
 *
 * @category Type-level
 */
export type Tabled<C extends ComponentDef> =
  C extends ComponentDef<Schema, "sparse">
    ? {
        readonly "Query.maybe takes only a component stored in tables: take it in Query.all without Query.maybe": NameOf<C>;
      }
    : unknown;

/**
 * Narrows a query to entities that also have these components, without
 * passing their data to the loop.
 *
 *   const Players = Query.all(Position).pipe(Query.with(Player))
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
      self.writeDefs,
      self.maybeDefs
    )
);

export {
  /**
   * Narrows a query to entities that also have these components, without
   * passing their data to the loop.
   */
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
      self.writeDefs,
      self.maybeDefs
    )
);

/**
 * Visits only the entities that had one of these components written since the
 * system last visited. A component an entity has just gained counts as
 * written. The components are required, as with `Query.with`.
 *
 * **Details**
 *
 * - Each system, and each action's handler, tracks its own position, and sees
 *   every change once. On its first visit, it sees every matching entity.
 * - `each`, `eachChunk` and `entities` count as visits. `count` only peeks.
 * - An entity is visited once however often it was written, in the usual query
 *   order. An entity that has since lost the component, or was despawned, isn't
 *   visited.
 * - A write is detected per entity by `world.set`, by adding the component with
 *   a value, and by assigning to a field in `each`. Reading records nothing.
 * - `eachChunk` hands out raw columns and can't detect writes. Every row it
 *   hands out of a component the query writes counts as written. See
 *   `Query.writes`.
 * - Only watched components are tracked. Writing a component no query watches
 *   costs nothing extra.
 * - A system that writes what it watches sees its own writes next time.
 * - A refused action's writes aren't changes. They are rolled back with
 *   everything else, as are the visits its handler made.
 * - Outside a system or a handler, in a test or in the entry point, there is
 *   one position per query, shared by every caller there.
 * - With several components, or combined with `Query.added`, an entity is
 *   visited when any one of them fired.
 * - `Save.make(app)` saves what a query has yet to visit, with each reader's
 *   position. It isn't part of the world's snapshot or hash.
 *
 * **Gotchas**
 *
 * - A system that `System.runIf` turned off sees nothing that changed while it
 *   was off, as it hears no event from then.
 * - List a system that watches a component after the systems that write it in
 *   the same tick, with a query, with `World.writes` or by spawning it.
 *   Otherwise it sees their writes a tick late. `App.define` and `Plugin.make`
 *   refuse a list the other way round, and the error names the two systems.
 *   See `System.Misordered`.
 * - A query that watches a component and writes it has no `eachChunk`, and a
 *   call doesn't compile, since the query would take its own visit for a
 *   change. Iterate with `each`.
 * - Raw columns are typed arrays all the same. A write to the column of a term
 *   the query only reads, past the compiler, is seen by no change query and by
 *   no check of the order. An app made with `verifyFrames` refuses it.
 *
 * @category Combinators
 */
export const changed: {
  <const C extends readonly ComponentDef[]>(
    ...defs: C
  ): <D extends Terms, W extends Watching>(
    self: Query<D, W> & Certain<D, C[number]>
  ) => Query<Watched<D, NameOf<C[number]>>, W | WatchesOf<NameOf<C[number]>>>;
  <
    D extends Terms,
    W extends Watching,
    const C extends readonly ComponentDef[],
  >(
    self: Query<D, W> & Certain<D, C[number]>,
    ...defs: C
  ): Query<Watched<D, NameOf<C[number]>>, W | WatchesOf<NameOf<C[number]>>>;
} = dual(
  (args) => args[0] instanceof Query,
  <
    D extends Terms,
    W extends Watching,
    const C extends readonly ComponentDef[],
  >(
    self: Query<D, W>,
    ...defs: C
  ): Query<Watched<D, NameOf<C[number]>>, W | WatchesOf<NameOf<C[number]>>> =>
    new Query<Watched<D, NameOf<C[number]>>, W | WatchesOf<NameOf<C[number]>>>(
      // The same terms, with the ones it watches marked in the type.
      self.terms as Terms as Watched<D, NameOf<C[number]>>,
      self.withDefs,
      self.withoutDefs,
      [...self.changedDefs, ...defs],
      self.addedDefs,
      self.writeDefs,
      self.maybeDefs
    )
);

/**
 * Visits only the entities that gained one of these components since the
 * system last visited, by a spawn or by `add`. It otherwise works as
 * `Query.changed` does.
 *
 * **Gotchas**
 *
 * - List a system that watches for a component after the systems that spawn or
 *   add it in the same tick, those that ask for it with `Commands.spawns`.
 *   Otherwise it sees the entities a tick late. `App.define` and `Plugin.make`
 *   refuse a list the other way round. See `System.Misordered`.
 *
 * @category Combinators
 */
export const added: {
  <const C extends readonly ComponentDef[]>(
    ...defs: C
  ): <D extends Terms, W extends Watching>(
    self: Query<D, W> & Certain<D, C[number]>
  ) => Query<D, W | WatchesAddedOf<NameOf<C[number]>>>;
  <
    D extends Terms,
    W extends Watching,
    const C extends readonly ComponentDef[],
  >(
    self: Query<D, W> & Certain<D, C[number]>,
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
      self.writeDefs,
      self.maybeDefs
    )
);

/**
 * What `Query.changed` and `Query.added` ask of the query they are given:
 * nothing, unless it takes one of their components with `Query.maybe`.
 *
 * @category Type-level
 */
export type Certain<D extends Terms, C extends ComponentDef> = [
  Extract<
    {
      [K in keyof D]: D[K] extends MaybeTerm ? NameOf<D[K]> : never;
    }[number],
    C extends unknown ? (string extends NameOf<C> ? never : NameOf<C>) : never
  >,
] extends [infer Uncertain]
  ? [Uncertain] extends [never]
    ? unknown
    : {
        readonly "Query.changed and Query.added require what they watch: take it in Query.all without Query.maybe": Uncertain;
      }
  : never;

/**
 * In a system's requirements, says that the system writes the component named
 * `N`. The system yields a query that names the component with
 * `Query.writes`, or asks for `World.writes` with it. Nobody writes this type
 * or provides it. A
 * system's type holds it, and `App.define` and `Plugin.make` read it there to
 * check the order of a list of systems.
 *
 * @category Type-level
 */
export interface Writes<out N extends string> {
  readonly "~arcadekit/Query/Writes": N;
}

/**
 * In a system's requirements, says that the system watches the component named
 * `N` for writes, because it yields a query made with `Query.changed`. As with
 * `Writes`, nobody writes this type or provides it.
 *
 * @category Type-level
 */
export interface Watches<out N extends string> {
  readonly "~arcadekit/Query/Watches": N;
}

/**
 * In a system's requirements, says that the system watches for entities that
 * gain the component named `N`, because it yields a query made with
 * `Query.added`. As with `Writes`, nobody writes this type or provides it.
 *
 * @category Type-level
 */
export interface WatchesAdded<out N extends string> {
  readonly "~arcadekit/Query/WatchesAdded": N;
}

/**
 * In a system's requirements, says that the system reads which entities lost
 * the component named `N`, because it yields `Query.removed`. What it has read
 * belongs to the game, so `app.read` doesn't take it. As with `Writes`, nobody
 * writes this type or provides it.
 *
 * @category Type-level
 */
export interface WatchesRemoved<out N extends string> {
  readonly "~arcadekit/Query/WatchesRemoved": N;
}

/**
 * In a system's requirements, says that the system gives entities the
 * component named `N`, by spawning them with it or adding it, because it asks
 * for its commands with `Commands.spawns`. As with `Writes`, nobody writes
 * this type or provides it.
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
export type Access =
  | Writes<string>
  | Adds<string>
  | Watching
  | WatchesRemoved<string>;

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
 * watches. A system that yields the query has these in its requirements.
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
      ? Unmarked<D[K], W> &
          (D[K] extends WatchedTerm ? WatchedTerm : unknown) &
          (D[K] extends MaybeTerm ? MaybeTerm : unknown)
      : D[K]
    : D[K];
} extends infer Marked extends Terms
  ? Marked
  : never;

/**
 * A query's terms, with the ones named `N` marked as watched for writes. A name
 * the compiler only knows as `string` marks none.
 *
 * @category Type-level
 */
export type Watched<D extends Terms, N extends string> = {
  [K in keyof D]: string extends N
    ? D[K]
    : NameOf<D[K]> extends N
      ? D[K] & WatchedTerm
      : D[K];
} extends infer Marked extends Terms
  ? Marked
  : never;

/**
 * What `Query.writes` asks of the query it is given: nothing, unless it was
 * given a component that isn't one of the query's terms. A name the compiler
 * only knows as `string` is left to the check at run time.
 *
 * @category Type-level
 */
export type OwnTerms<D extends Terms, W extends ComponentDef> = [
  Exclude<
    W extends unknown ? (string extends NameOf<W> ? never : NameOf<W>) : never,
    NameOf<D[number]>
  >,
] extends [infer Strangers]
  ? [Strangers] extends [never]
    ? unknown
    : {
        readonly "Query.writes takes only the query's terms: add it to Query.all, or require it without its data with Query.with": Strangers;
      }
  : never;

/**
 * Names the terms a query writes. The query only reads every term this
 * doesn't name.
 *
 *   const Moving = Query.all(Position, Velocity).pipe(Query.writes(Position))
 *
 * **Details**
 *
 * - For a term the query only reads, `each` hands out an accessor whose fields
 *   can't be assigned. The compiler rejects an assignment, and at run time it
 *   throws.
 * - `eachChunk` hands out the columns of a term the query only reads typed as
 *   read-only, and doesn't count their rows as written. Every row it hands out
 *   of a term the query writes counts as written for the change queries that
 *   watch it, since raw columns can't tell a read from a write.
 * - In an action's handler, only the columns of what the query writes are
 *   copied for a rollback.
 * - Each loop counts what it writes as changed in every table it visits, for
 *   `world.hash()`, `Timeline.capture` and `Timeline.rewind`, which work
 *   again only on what changed. A component it only reads costs them
 *   nothing.
 *
 * **Gotchas**
 *
 * - It takes only the query's terms. Another component doesn't compile, and
 *   one the compiler knows only as a `ComponentDef` throws. To require a
 *   component without its data, use `Query.with`.
 * - Raw columns are typed arrays all the same. A loop that writes one past the
 *   compiler has still written it. No change query sees that write, and no
 *   refusal rolls it back, unless the app was made with `verifyFrames`, which
 *   refuses the loop and puts the column back.
 *
 * @category Combinators
 */
export const writes: {
  <const W extends readonly [ComponentDef, ...ComponentDef[]]>(
    ...defs: W
  ): <D extends Terms, Wa extends Watching>(
    self: Query<D, Wa> & OwnTerms<D, W[number]>
  ) => Query<Writing<D, W[number]>, Wa>;
  <
    D extends Terms,
    Wa extends Watching,
    const W extends readonly [ComponentDef, ...ComponentDef[]],
  >(
    self: Query<D, Wa> & OwnTerms<D, W[number]>,
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
      ),
      self.maybeDefs
    );
  }
);

/**
 * The entities that lost a component since the system last read, as
 * `Query.removed` makes it. `(yield* Query.removed(Sprite)).read()` returns
 * their ids, oldest first, once per removal. A despawned entity lost
 * everything it had, and its id is no longer alive.
 *
 * Removals are tracked from the first read, and each system and handler tracks
 * its own position.
 *
 * **Gotchas**
 *
 * - The order of a list of systems isn't checked for removals, as it is for
 *   `Query.changed` and `Query.added`, since a despawn doesn't say which
 *   components its entity had. A system that reads removals, listed ahead of
 *   the system that despawns or removes, reads them a tick late. List it after.
 *
 * @category Models
 */
export class Removed<N extends string = string> extends Effectable.Class<
  RemovedReader,
  never,
  World | WatchesRemoved<N>
> {
  private effect:
    | Effect.Effect<RemovedReader, never, World | WatchesRemoved<N>>
    | undefined;

  constructor(readonly component: ComponentDef) {
    super();
  }

  asEffect(): Effect.Effect<RemovedReader, never, World | WatchesRemoved<N>> {
    return (this.effect ??= Effect.map(Effect.service(World), (world) =>
      whole(world).removed(this.component)
    ));
  }
}

/**
 * Makes a reader of the entities that lost a component since the system last
 * read.
 *
 *   const Extinguished = Query.removed(Burning)
 *   for (const entity of (yield* Extinguished).read()) { ... }
 *
 * @category Constructors
 */
export const removed = <const D extends ComponentDef>(
  component: D
): Removed<NameOf<D>> => new Removed(component);
