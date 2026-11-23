/**
 * The id of an entity that is spawned and not placed yet, and the types that
 * hand it on.
 *
 * No Effect dependency.
 */
import { entityIndex } from "./component";
import type { Entity } from "./component";
import { NOT_PLACED } from "./records";
import type { World } from "./world";

/**
 * The id `Commands.spawn` returns, of an entity that is placed, with its
 * components, when the system or handler that spawned it finishes. Until
 * then the world holds no such entity, so the world's reads don't take it:
 * `Commands` does, to add to it, remove from it or despawn it, and so does a
 * component's value, to point an entity field or a relation at it.
 *
 * An action's handler that returns one hands it to `app.dispatch` as an
 * `Entity`, since the handler has finished by then.
 *
 * @category Models
 */
export type Spawned = number & { readonly _spawned: "Spawned" };

/**
 * A value as it is handed on once the spawns before it are applied, such as
 * what a handler returns, which `app.dispatch` gives back: each `Spawned` id
 * in it, alone, in an array or in an object, is an `Entity`.
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
 * A value as the simulation hands it on to be read after its spawns are
 * applied, such as an event's payload or an action it enqueues: each
 * `Entity` in it may be a `Spawned` id too.
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
 * The entity of an id `Commands.spawn` returned, once its spawn is applied,
 * and undefined before then, or if it never was: the commands of a system are
 * applied when it finishes.
 */
export const placed = (world: World, id: Spawned): Entity | undefined => {
  // The same number: a spawn reserves the id it gives.
  const entity = id as number as Entity;
  return world.isAlive(entity) &&
    world._recTable[entityIndex(entity)] !== NOT_PLACED
    ? entity
    : undefined;
};
