/**
 * Stored values: what a save's or a setting's service gives, a `read` of what is kept and a
 * `write` that keeps a new value.
 *
 * `Save` and `Setting` are declarations with a service, and both services are a `Stored`: the
 * class is its key, and its `layer` makes one over the app's `KeyValueStore`. Neither Effect
 * fails, since a game plays on without what it couldn't keep: a storage problem is logged. The
 * value is data on a prototype with a `TypeId`, as the service of Effect's `KeyValueStore` has
 * one, so a guard tells it from a look-alike and a log prints it.
 *
 * @since 0.7.0
 */
import { Inspectable, Pipeable, Predicate } from "effect";
import type { Effect, Types } from "effect";

const TypeId = "~arcadekit/save/Stored";

/**
 * What a save's or a setting's service gives: `read`, which gives what is stored, and `write`,
 * which stores a value and gives what is stored after it. Neither fails: a storage problem is
 * logged and play goes on.
 *
 * **When to use**
 *
 * Name it to type what `yield* RaceSave` gives, as a helper that takes the service does. A game
 * reads it from its declaration's class.
 *
 * **Details**
 *
 * `read` reads storage on every run and keeps nothing, so it gives what another tab wrote. A
 * missing value reads as the declaration's own (a save's is empty, a setting's is its `default`),
 * and so does one that can't be read, which is logged. A save's `write` merges into what it could
 * read; a setting's replaces what is stored, unless it declares a `merge`. A write gives the
 * value after it, also when storage refuses it, which is logged. A declaration's writes run one
 * at a time.
 *
 * **Example** (A save's service)
 *
 * ```ts
 * import { Save, Stored } from "arcadekit/save";
 * import type { Records } from "arcadekit/save";
 * import { Effect, Layer, Schema } from "effect";
 * import { KeyValueStore } from "effect/persistence";
 *
 * const Lap = Schema.Struct({ bestLap: Schema.Number });
 * class RaceSave extends Save("RaceSave", {
 *   storageKey: "my-studio/race/save",
 *   record: Lap,
 *   mergeRecord: (a, b) => (a.bestLap <= b.bestLap ? a : b),
 * }) {}
 *
 * const program = Effect.gen(function* () {
 *   const save: Stored.Stored<Records<typeof Lap.Type>> = yield* RaceSave;
 *   yield* save.write({ oval: { bestLap: 61.2 } });
 *   return yield* save.write({ oval: { bestLap: 64 } });
 * });
 * const layer = RaceSave.layer.pipe(Layer.provide(KeyValueStore.layerMemory));
 * const records = Effect.runSync(program.pipe(Effect.provide(layer)));
 * records; // => { oval: { bestLap: 61.2 } }
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Stored<A> extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** What is stored, read from storage on every run. */
  readonly read: Effect.Effect<A>;
  /** Stores `value`, merged with what is stored where the declaration merges, and gives what it stored. */
  readonly write: (value: A) => Effect.Effect<A>;
}

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON() {
    return { _id: "Stored" };
  },
};

/**
 * Checks whether a value is a save's or a setting's service.
 *
 * **When to use**
 *
 * Narrow an unknown value before reading or writing through it, as a debugging tool that lists
 * an app's services does.
 *
 * **Details**
 *
 * A stored value comes from a declaration's `layer` or from `make`. An object with a `read` and a
 * `write` of its own is none.
 *
 * **Example** (Recognising a stored value)
 *
 * ```ts
 * import { Stored } from "arcadekit/save";
 * import { Effect } from "effect";
 *
 * const volume = Stored.make({ read: Effect.succeed(0.8), write: Effect.succeed });
 * Stored.isStored(volume); // => true
 * Stored.isStored({ read: Effect.succeed(0.8), write: Effect.succeed }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isStored = (value: unknown): value is Stored<unknown> =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a stored value from its `read` and its `write`.
 *
 * **When to use**
 *
 * In a test of an app's own code that reads or writes a save or a setting, to give it the
 * service with no storage under it: `Layer.succeed(RaceSave, Stored.make({ ... }))`. A
 * declaration's `layer` makes the one an app runs on.
 *
 * **Details**
 *
 * Neither Effect may fail, as a declaration's never do: an app's code reads and writes without
 * handling a failure. `make` runs neither: each run of `read`, and each call of `write`, runs what
 * it was given.
 *
 * **Example** (A setting's service with no storage, for a test)
 *
 * ```ts
 * import { Setting, Stored } from "arcadekit/save";
 * import { Effect, Layer, Schema } from "effect";
 *
 * class RaceVolume extends Setting("RaceVolume", {
 *   storageKey: "my-studio/race/volume",
 *   schema: Schema.Number,
 *   default: 0.8,
 * }) {}
 *
 * const written: number[] = [];
 * const fake = Layer.succeed(
 *   RaceVolume,
 *   Stored.make({
 *     read: Effect.succeed(0.5),
 *     write: (volume: number) => Effect.sync(() => written.push(volume)).pipe(Effect.as(volume)),
 *   })
 * );
 * const program = Effect.gen(function* () {
 *   const volume = yield* RaceVolume;
 *   return yield* volume.write((yield* volume.read) / 2);
 * });
 * Effect.runSync(program.pipe(Effect.provide(fake))); // => 0.25
 * written; // => [0.25]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = <A>(options: {
  readonly read: Effect.Effect<A>;
  readonly write: (value: A) => Effect.Effect<A>;
}): Stored<A> => {
  const self = Object.create(Proto) as Types.Mutable<Stored<A>>;
  self.read = options.read;
  self.write = options.write;
  return self;
};
