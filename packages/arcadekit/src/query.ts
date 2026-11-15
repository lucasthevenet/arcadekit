/**
 * Query descriptions that can be yielded inside systems:
 *
 *   const Moving = Query.all(Position, Velocity).pipe(Query.without(Stunned))
 *   const moving = yield* Moving
 */
import { Effect, Effectable } from "effect";
import { dual } from "effect/Function";

import type { ComponentDef } from "./ecs/component";
import type { QuerySpec, QueryView, Terms } from "./ecs/world";
import { World } from "./services";

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
    readonly withoutDefs: readonly ComponentDef<any>[]
  ) {
    super();
  }

  asEffect(): Effect.Effect<QueryView<D>, never, World> {
    // Built once and reused: the world caches the view per query, so after
    // the first tick this is a service lookup plus a Map hit.
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
    new Query(self.terms, [...self.withDefs, ...defs], self.withoutDefs)
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
    new Query(self.terms, self.withDefs, [...self.withoutDefs, ...defs])
);
