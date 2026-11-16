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

import type { ComponentDef } from "./ecs/component";
import type { QuerySpec, QueryView, RemovedReader, Terms } from "./ecs/world";
import { World } from "./Services";

/**
 * An immutable, world-independent query description.
 *
 * It extends `Effectable.Class`, which makes it an Effect: `yield*` works on
 * it, `.pipe()` comes for free, and the `World` requirement shows up in the
 * type of any system that uses it.
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
    readonly addedDefs: readonly ComponentDef<any>[] = []
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

/** Entities that have all of these components; their data is passed to the loop. */
export const all = <const D extends Terms>(...terms: D): Query<D> =>
  new Query(terms, [], []);

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
      self.addedDefs
    )
);

export {
  /** Also require these components, without reading their data. */
  with_ as with,
};

/** Exclude entities that have any of these components. */
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
      self.addedDefs
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
      self.addedDefs
    )
);

/**
 * Visit only the entities that gained one of these components since whoever
 * is asking last visited: by being spawned with it, or by `add`. Otherwise
 * as `Query.changed`.
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
    new Query(self.terms, self.withDefs, self.withoutDefs, self.changedDefs, [
      ...self.addedDefs,
      ...defs,
    ])
);

/**
 * The entities that lost a component since whoever is asking last read:
 * `(yield* Query.removed(Sprite)).read()` gives their ids, oldest first,
 * once per removal. An entity that was despawned lost all it had, and its
 * id is no longer alive. Removals are noticed from the first time a reader
 * asks, and each system and handler has its own place in them.
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

export const removed = (component: ComponentDef<any>): Removed =>
  new Removed(component);
