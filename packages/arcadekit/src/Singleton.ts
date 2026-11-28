/**
 * Singletons hold data that exists once per world, such as whose turn it is, so
 * you can read it without a query and a loop.
 *
 *   const Turn = Singleton.define("duel/Turn", { player: Field.u8 }, { player: 1 })
 *
 *   const turn = yield* Singleton.Read(Turn)              // read, in any stage
 *   if (turn.player !== mine) return yield* NotYourTurn.make({})
 *   const writing = yield* Singleton.Write(Turn)    // in the code of the tick
 *   writing.player = writing.player === 1 ? 2 : 1
 *
 * The value belongs to the world. A save holds it, the world's hash includes
 * it, and a refused action's writes to it are rolled back with the rest. For
 * configuration that isn't game state, use a `Resource`, a value with a
 * default that a layer can override, which no save holds.
 */
import type { Effect } from "effect";

import { Component } from "./ecs/component.ts";
import type {
  ComponentDef,
  FieldDef,
  Schema,
  SingletonSpec,
  ValueOf,
} from "./ecs/component.ts";
import { lookup, service } from "./internal/lookup.ts";
import type { Given } from "./internal/lookup.ts";
import { World } from "./Services.ts";
import type { Sim } from "./Services.ts";

declare const LiveBrand: unique symbol;

// A getter of a class, which a spread drops: a copy is not the world's object.
declare abstract class LiveObject {
  get [LiveBrand](): true;
}
interface Live extends LiveObject {}

declare const WritesBrand: unique symbol;

// The same, for the value that `writes` gives: a read is not a write.
declare abstract class WritesObject {
  get [WritesBrand](): true;
}
interface Writes extends WritesObject {}

/**
 * A singleton's value as `yield*` and `World.singleton` read it: the world's
 * own object, read-only, and the same object on every read. Its fields are
 * plain data, and so is a spread of it, `{ ...(yield* Singleton.Read(Score)) }`. Whole, it is
 * refused as a view's value, by `View.publish` and `View.Port.publish`, and as
 * what `when` returns, since it would never differ from one frame to the next.
 *
 * @category Models
 */
export type Read<S extends Schema> = Readonly<ValueOf<S>> & Live;

/**
 * The value `yield* Singleton.Write(T)` gives for the singleton `T`: the world's own
 * object, as `Singleton.Read` is, with fields that can be assigned. A plain
 * function that writes a singleton for the system that calls it takes one.
 *
 *   const Score = Singleton.define("game/Score", { points: Field.u32 }, { points: 0 })
 *
 *   const award = (score: Singleton.Write<typeof Score>, points: number) => {
 *     score.points += points
 *   }
 *   award(yield* Singleton.Write(Score), 10)   // in a system of the tick
 *
 * @category Models
 */
export type Write<T extends Singleton<Schema>> =
  T extends Singleton<infer S> ? ValueOf<S> & Live & Writes : never;

/**
 * A singleton's definition, as `Singleton.define` makes it.
 * `yield* Singleton.Read(SomeSingleton)` returns its value in the world,
 * read-only, as a `Singleton.Read`. `yield* Singleton.Write(SomeSingleton)`
 * returns the same value with fields that can be assigned. Only the code of
 * the tick can ask for that one: a system of the tick, a handler or a
 * plugin's setup.
 *
 * @category Models
 */
export class Singleton<S extends Schema> implements SingletonSpec<S> {
  constructor(
    readonly component: ComponentDef<S>,
    readonly initial: ValueOf<S>
  ) {}

  /** The singleton's name, which is one of the world's component names. */
  get name(): string {
    return this.component.name;
  }
}

const valueOf = <S extends Schema>(
  given: Given,
  singleton: Singleton<S>
): Read<S> => service(given, World).singleton(singleton);

/**
 * Asks for a singleton's value in the world, read-only, as a
 * `Singleton.Read`. The code of any stage can ask.
 *
 *   const { points } = yield* Singleton.Read(Score)
 *
 * @category Capabilities
 */
export const Read = <S extends Schema>(
  singleton: Singleton<S>
): Effect.Effect<Read<S>, never, World> => lookup(valueOf, singleton);

/**
 * Asks for a singleton's value with fields that can be assigned. Asking for
 * it adds `Sim` to the system's requirements, and a system of the frame or
 * input stage that requires `Sim` doesn't compile.
 *
 *   const score = yield* Singleton.Write(Score)
 *   score.points += 10
 *
 * @category Capabilities
 */
export const Write = <S extends Schema>(
  singleton: Singleton<S>
): Effect.Effect<ValueOf<S> & Live & Writes, never, World | Sim> =>
  lookup(
    valueOf as (
      given: Given,
      singleton: Singleton<S>
    ) => ValueOf<S> & Live & Writes,
    singleton
  );

/**
 * Defines a singleton from its name, its fields, and `initial`, its value in a
 * world that hasn't written it.
 *
 *   const Score = Singleton.define("game/Score", { points: Field.u32 }, { points: 0 })
 *
 * A singleton whose every field holds an initial of its own, as a
 * `Field.json`, `Field.schema` or `Field.ref` field does, may leave `initial`
 * out, and starts at its fields' initials:
 *
 *   const Seen = Singleton.define("game/Seen", { names: Field.json<readonly string[]>([]) })
 *
 * A number field, a `Field.bool`, a `Field.entity` and a `Field.transient`
 * hold none, and neither does a `Field.json` whose type takes `undefined`.
 * Leaving `initial` out of a singleton that has one of them doesn't compile.
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
  ...initial: InitialArgs<S>
): Singleton<S> => {
  const spec = Component.singleton(
    name,
    schema,
    initial[0] ??
      (Object.fromEntries(
        Object.entries(schema).map(([key, field]) => [key, field.initial])
      ) as ValueOf<S>)
  );
  return new Singleton(spec.component, spec.initial);
};

/**
 * Whether a field holds an initial of its own, as a `json`, `ref` or `schema`
 * field does: its column is an array, and its value is never undefined. A
 * `transient` field's value can be undefined, and so can a `json` field's whose
 * type takes it. The type can't tell those two apart, so neither counts.
 */
type Carries<F> =
  F extends FieldDef<infer T, infer C>
    ? C extends readonly unknown[]
      ? undefined extends T
        ? false
        : true
      : false
    : false;

/**
 * The `initial` that `define` takes: one that may be left out when every field
 * holds an initial of its own.
 */
type InitialArgs<S extends Schema> = [
  { [K in keyof S]: Carries<S[K]> extends true ? never : K }[keyof S],
] extends [never]
  ? [initial?: ValueOf<S>]
  : [initial: ValueOf<S>];
