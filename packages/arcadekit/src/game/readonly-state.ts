/**
 * Read-only state: a run's state as the code that only reads it sees it.
 *
 * A run's state is open on purpose: every module of a game reads it, and only the step and the
 * commands' handlers write it, so a step writes its typed arrays directly and allocates nothing.
 * What only reads a run, a view, a sample and a state hash, is given it read-only, so the
 * compiler refuses a write there that would change one peer's run and not another's. It is a
 * type and nothing more: what they are given is the run's own state, not a copy.
 *
 * @since 0.8.0
 */
import type {
  EntityPool,
  Layout,
  Ring,
  Rng,
  SpatialGrid,
  TileMap,
} from "../core/index";

/** What a run's state holds that is a value, not a place to write. */
type Primitive = string | number | boolean | bigint | symbol | null | undefined;

/**
 * A run's state, or any part of it, as the code that only reads it sees it: every field
 * read-only, all the way down.
 *
 * **When to use**
 *
 * Name it for a genre's function that a view, a sample or a state hash calls, such as the one
 * that reads a HUD's sample: `(arena: Game.ReadonlyState<World.Arena>) => ...`. A view's
 * `render`, a sample's `version` and `read`, and a `Coop`'s `hash` are given the state as one.
 *
 * **Details**
 *
 * It makes each object's fields read-only, each array a read-only array, and each typed array a
 * `Layout.ReadonlyTypedArray`. A structure of `arcadekit/core` becomes its read-only form:
 * `EntityPool.ReadonlyEntityPool`, `EntityPool.ReadonlyIdentified`, `Ring.ReadonlyRing`,
 * `TileMap.ReadonlyTileMap`, `SpatialGrid.ReadonlySpatialGrid` and `Rng.ReadonlyRng`, which the
 * functions that only read take and those that write refuse. A function is left as it is.
 *
 * The writable state is one, so a function that takes it takes either. The guard is the
 * compiler's, and it has one gap: TypeScript lets an object whose fields are read-only pass where
 * one with writable fields is taken, so a reader that hands a plain object of the state, such as
 * a hero, to a function that writes it still compiles. Arrays, typed arrays and the structures of
 * `arcadekit/core` don't pass.
 *
 * **Example** (A sample that can't change the run)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 * import * as Game from "arcadekit/game";
 *
 * const ENEMY = { hp: Float32Array } as const;
 *
 * interface Arena {
 *   time: number;
 *   readonly enemies: EntityPool.EntityPool<typeof ENEMY>;
 * }
 *
 * const hudOf = (arena: Game.ReadonlyState<Arena>) => ({
 *   time: arena.time,
 *   enemies: arena.enemies.count,
 * });
 *
 * const arena: Arena = { time: 2.5, enemies: EntityPool.make(8, ENEMY) };
 * arena.enemies.fields.hp[EntityPool.add(arena.enemies)] = 10;
 * hudOf(arena); // => { time: 2.5, enemies: 1 }
 *
 * const heal = (arena: Game.ReadonlyState<Arena>) => {
 *   // @ts-expect-error A reader can't write a field of the state.
 *   arena.time = 0;
 *   // @ts-expect-error Nor an element of a pool's field.
 *   arena.enemies.fields.hp[0] = 100;
 *   // @ts-expect-error Nor add to a pool.
 *   EntityPool.add(arena.enemies);
 * };
 * ```
 *
 * @category utility types
 * @since 0.8.0
 */
export type ReadonlyState<T> = T extends Primitive
  ? T
  : T extends (...args: never) => unknown
    ? T
    : T extends EntityPool.Identified<infer L>
      ? EntityPool.ReadonlyIdentified<L>
      : T extends EntityPool.EntityPool<infer L>
        ? EntityPool.ReadonlyEntityPool<L>
        : T extends Ring.Ring<infer L>
          ? Ring.ReadonlyRing<L>
          : T extends TileMap.TileMap<infer L>
            ? TileMap.ReadonlyTileMap<L>
            : T extends SpatialGrid.SpatialGrid
              ? SpatialGrid.ReadonlySpatialGrid
              : T extends Rng.Rng
                ? Rng.ReadonlyRng
                : T extends Layout.TypedArray
                  ? Layout.ReadonlyTypedArray<T>
                  : T extends ReadonlyMap<infer K, infer V>
                    ? ReadonlyMap<ReadonlyState<K>, ReadonlyState<V>>
                    : T extends ReadonlySet<infer E>
                      ? ReadonlySet<ReadonlyState<E>>
                      : { readonly [K in keyof T]: ReadonlyState<T[K]> };
