/**
 * The id of an entity that is spawned and not placed yet, and the types that
 * hand it on.
 *
 * No Effect dependency.
 */
import { entityIndex, placedOf } from "./component";
import type { Entity } from "./component";
import { NOT_PLACED } from "./records";
import type { World } from "./world";

declare const SpawnedBrand: unique symbol;

/**
 * The id that `Commands.spawn` returns. The entity is placed, with its
 * components, when the system or handler that spawned it finishes. Until then
 * the world holds no such entity, so the world's reads don't take a `Spawned`
 * id.
 *
 * `Commands` takes one, to add to the entity, remove from it or despawn it. A
 * component's value takes one too, to point an entity field or a relation at
 * the entity. An action's handler that returns one hands it to `app.dispatch`
 * as an `Entity`, since the handler has finished by then.
 *
 * @category Models
 */
export type Spawned = { readonly [SpawnedBrand]: true };

/**
 * A value as it is handed on once the spawns before it are applied, such as
 * what a handler returns and `app.dispatch` gives back. Each `Spawned` id in
 * it becomes an `Entity`, whether alone, in an array or in an object.
 *
 * @category Type-level
 */
export type Placed<A> = A extends Spawned
  ? Entity
  : A extends (...args: never) => unknown
    ? A
    : A extends object
      ? { [K in keyof A]: Placed<A[K]> }
      : A;

/**
 * A value that the simulation hands on to be read after its spawns are
 * applied, such as an event's payload or an action it enqueues. Each `Entity`
 * in it may also be a `Spawned` id.
 *
 * @category Type-level
 */
export type WithSpawned<P> = P | Unplaced<P>;

type Unplaced<P> = P extends Entity
  ? Entity | Spawned
  : P extends (...args: never) => unknown
    ? P
    : P extends object
      ? { [K in keyof P]: Unplaced<P[K]> }
      : P;

/**
 * Returns the entity of an id that `Commands.spawn` returned, once its spawn
 * is applied. Returns undefined before then, once the entity is despawned, and
 * for a spawn that was never applied. The commands of a system are applied
 * when the system finishes.
 *
 * **When to use**
 *
 * Use with the storage core alone. In a game, the `World` service's `placed`
 * does the same.
 *
 * @category Utilities
 */
export const placed = (world: World, id: Spawned): Entity | undefined => {
  const entity = placedOf(id);
  return world.isAlive(entity) &&
    world._recTable[entityIndex(entity)] !== NOT_PLACED
    ? entity
    : undefined;
};
