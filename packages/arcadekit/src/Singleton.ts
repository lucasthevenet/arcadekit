/**
 * Singletons hold data that exists once per world, such as whose turn it is, so
 * you can read it without a query and a loop.
 *
 *   const Turn = Singleton.define("duel/Turn", { player: Field.u8 }, { player: 1 })
 *
 *   const turn = yield* Turn              // read, in any stage
 *   if (turn.player !== mine) return yield* new NotYourTurn()
 *   const writing = yield* Turn.writes    // a tick system or a handler
 *   writing.player = writing.player === 1 ? 2 : 1
 *
 * The value belongs to the world: it is saved with it and included in its hash,
 * and a refused action's writes to it are rolled back with everything else. For
 * configuration that isn't game state, use a `Resource`: a value with a default
 * that a layer can override, which isn't saved.
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
import type { Sim } from "./Services";

/**
 * A singleton's definition. It is an Effect, so `yield*` returns the world's
 * value to be read. `yield* SomeSingleton.writes` returns the same value with
 * fields that can be assigned, and only a system of the tick or a handler can
 * ask for it.
 *
 * @category Models
 */
export class Singleton<S extends Schema>
  extends Effectable.Class<Readonly<ValueOf<S>>, never, World>
  implements SingletonSpec<S>
{
  private effect: Effect.Effect<Readonly<ValueOf<S>>, never, World> | undefined;
  private writing: Effect.Effect<ValueOf<S>, never, World | Sim> | undefined;

  constructor(
    readonly component: ComponentDef<S>,
    readonly initial: ValueOf<S>
  ) {
    super();
  }

  /** The singleton's name, which is one of the world's component names. */
  get name(): string {
    return this.component.name;
  }

  asEffect(): Effect.Effect<Readonly<ValueOf<S>>, never, World> {
    return (this.effect ??= Effect.map(Effect.service(World), (world) =>
      world.singleton(this)
    ));
  }

  /**
   * The same value, with fields that can be assigned. Requiring it puts `Sim`
   * in the system's requirements, which a frame or input system does not
   * accept.
   */
  get writes(): Effect.Effect<ValueOf<S>, never, World | Sim> {
    return (this.writing ??= Effect.map(Effect.service(World), (world) =>
      world.singleton(this)
    ));
  }
}

/**
 * Defines a singleton: its name, its fields, and its value in a world that
 * hasn't written it.
 *
 * - The fields are a component's: typed numeric fields, and `Field.json`,
 *   `Field.schema` or `Field.transient` for anything else.
 * - The name is one of the world's component names, prefixed with the feature
 *   it belongs to. A save that holds the singleton finds it by that name.
 * - Until it is written, it holds `initial` and behaves as if absent: it isn't
 *   saved, and a world that has only read it hashes the same as one that never
 *   did. A game loaded from a save where it was never written starts it at the
 *   `initial` of the build that loads it.
 * - No entity has it, and no query visits it: spawning or adding it throws.
 * - A migration changes it by name with `Migrate`, as it does a component.
 *
 * @category Constructors
 */
export const define = <S extends Schema>(
  name: string,
  schema: S,
  initial: ValueOf<S>
): Singleton<S> => {
  const spec = Component.singleton(name, schema, initial);
  return new Singleton(spec.component, spec.initial);
};
