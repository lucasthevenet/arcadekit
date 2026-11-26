/**
 * Singletons hold data that exists once per world, such as whose turn it is, so
 * you can read it without a query and a loop.
 *
 *   const Turn = Singleton.define("duel/Turn", { player: Field.u8 }, { player: 1 })
 *
 *   const turn = yield* Turn              // read, in any stage
 *   if (turn.player !== mine) return yield* NotYourTurn.make({})
 *   const writing = yield* Turn.writes    // in the code of the tick
 *   writing.player = writing.player === 1 ? 2 : 1
 *
 * The value belongs to the world. A save holds it, the world's hash includes
 * it, and a refused action's writes to it are rolled back with the rest. For
 * configuration that isn't game state, use a `Resource`, a value with a
 * default that a layer can override, which no save holds.
 */
import { Effect, Effectable } from "effect";

import { Component } from "./ecs/component.ts";
import type {
  ComponentDef,
  Schema,
  SingletonSpec,
  ValueOf,
} from "./ecs/component.ts";
import { World } from "./Services.ts";
import type { Sim } from "./Services.ts";

declare const LiveBrand: unique symbol;

// A getter of a class, which a spread drops: a copy is not the world's object.
declare abstract class LiveObject {
  get [LiveBrand](): true;
}
interface Live extends LiveObject {}

/**
 * A singleton's value as `yield*` and `World.singleton` read it: the world's
 * own object, read-only, and the same object on every read. Its fields are
 * plain data, and so is a spread of it, `{ ...(yield* Score) }`. Whole, it is
 * refused as a view's value, by `View.publish` and `View.Port.publish`, and as
 * what `when` returns, since it would never differ from one frame to the next.
 *
 * @category Models
 */
export type Read<S extends Schema> = Readonly<ValueOf<S>> & Live;

/**
 * A singleton's definition, as `Singleton.define` makes it. It is an Effect,
 * and `yield*` returns its value in the world, read-only, as a
 * `Singleton.Read`.
 * `yield* SomeSingleton.writes` returns the same value with fields that can be
 * assigned. Only the code of the tick can ask for it: a system of the tick, a
 * handler or a plugin's setup.
 *
 * @category Models
 */
export class Singleton<S extends Schema>
  extends Effectable.Class<Read<S>, never, World>
  implements SingletonSpec<S>
{
  private effect: Effect.Effect<Read<S>, never, World> | undefined;
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

  asEffect(): Effect.Effect<Read<S>, never, World> {
    return (this.effect ??= Effect.map(Effect.service(World), (world) =>
      world.singleton(this)
    ));
  }

  /**
   * The same value, with fields that can be assigned. Asking for it adds `Sim`
   * to the system's requirements, and a system of the frame or input stage
   * that requires `Sim` doesn't compile.
   */
  get writes(): Effect.Effect<ValueOf<S>, never, World | Sim> {
    return (this.writing ??= Effect.map(Effect.service(World), (world) =>
      world.singleton(this)
    ));
  }
}

/**
 * Defines a singleton from its name, its fields, and its value in a world that
 * hasn't written it.
 *
 * **Details**
 *
 * - The fields are a component's: typed numeric fields, and `Field.json`,
 *   `Field.schema` or `Field.transient` for anything else.
 * - The name is one of the world's component names, prefixed with the feature
 *   it belongs to. A save that holds the singleton finds it by that name.
 * - Until it is written, it holds `initial` and behaves as if absent. No save
 *   holds it, and a world that has only read it hashes the same as one that
 *   never did. A game loaded from a save where it was never written starts it
 *   at the `initial` of the build that loads it.
 * - No entity has it, and no query visits it. Spawning it, or adding it to an
 *   entity, throws.
 * - A migration changes it with `Migrate.step`, by its definition, as it
 *   does a component.
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
