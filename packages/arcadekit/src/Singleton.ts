/**
 * Singletons: one instance of some data per world, such as whose turn it
 * is, without a query and a loop to read it.
 *
 *   const Turn = Singleton.define("duel/Turn", { player: Field.u8 }, { player: 1 })
 *
 *   const turn = yield* Turn          // in a system, a handler or a script
 *   if (turn.player !== mine) return yield* Effect.fail(new NotYourTurn())
 *   turn.player = turn.player === 1 ? 2 : 1
 *
 * The value is the world's. It is saved with the world and counted in its
 * hash, and what a refused action wrote to it is taken back with the rest.
 * A `Resource` is the other kind of single value: configuration with a
 * default that a layer can override, which is not game state and is not
 * saved.
 */
import { Effect, Effectable } from "effect";

import { Component } from "./ecs/component";
import type {
  ComponentDef,
  Schema,
  SingletonSpec,
  ValueOf,
} from "./ecs/component";
import { World } from "./Services";

/**
 * A singleton's definition. It is an Effect, so `yield*` gives the world's
 * value of it: an object whose fields are read and written in place.
 */
export class Singleton<S extends Schema>
  extends Effectable.Class<ValueOf<S>, never, World>
  implements SingletonSpec<S>
{
  private effect: Effect.Effect<ValueOf<S>, never, World> | undefined;

  constructor(
    readonly component: ComponentDef<S>,
    readonly initial: ValueOf<S>
  ) {
    super();
  }

  /** The singleton's name: one of the world's component names. */
  get name(): string {
    return this.component.name;
  }

  asEffect(): Effect.Effect<ValueOf<S>, never, World> {
    return (this.effect ??= Effect.map(Effect.service(World), (world) =>
      world.singleton(this)
    ));
  }
}

/**
 * Defines a singleton: its name, its fields, and the value it has in a
 * world that has not written it.
 *
 * - The fields are a component's: numbers in typed fields, and `Field.json`,
 *   `Field.schema` or `Field.transient` for anything else.
 * - The name is one of the world's component names, prefixed with the
 *   feature it belongs to. List the singleton in a plugin's `components`,
 *   so that a save which names it can be loaded.
 * - Until it is written it holds `initial`, and is as good as absent: a
 *   world that has only read it hashes the same as one that never asked.
 * - No entity has it, and no query visits it.
 */
export const define = <S extends Schema>(
  name: string,
  schema: S,
  initial: ValueOf<S>
): Singleton<S> => {
  const spec = Component.singleton(name, schema, initial);
  return new Singleton(spec.component, spec.initial);
};
