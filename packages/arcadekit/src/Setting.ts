/**
 * A setting is a choice that outlives a game: a volume, the keys a player
 * bound, the levels unlocked, the last slot played. It is kept outside the
 * world, so no save holds it, the world's hash leaves it out, and a rewind or
 * a load leaves it as it is.
 *
 *   const Volume = Setting.define("game/Volume", Schema.Number, 1)
 *
 *   const volume = yield* Volume          // in the frame or input stage, or a menu
 *   yield* Setting.set(Volume, 0.5)       // kept at once, and after a reload
 *
 * Settings are kept in `Setting.Store`. A page keeps them in its local
 * storage, `Setting.layer(Browser.settings("mygame"))`, and a test in memory,
 * `Setting.layer(Setting.makeMemory())`.
 *
 * The code of the tick can't read a setting: a system of the tick, an
 * action's handler or a plugin's setup that yields one doesn't compile, since
 * a replay, a save and the other peers of a session have none of it. What of
 * a setting changes the game, such as its difficulty, goes in as an action,
 * which the log holds.
 */
import {
  Cause,
  Context,
  Data,
  Effect,
  Effectable,
  Exit,
  Layer,
  Schema,
} from "effect";
import { dual } from "effect/Function";

import { said } from "./internal/intake.ts";

/**
 * Where a program keeps its settings, by key, each as the text of its value's
 * JSON form. A page keeps them in its local storage, with
 * `Browser.settings(name)`, and a test in memory, with `Setting.makeMemory()`.
 *
 * @category Services
 */
export interface StoreShape {
  /**
   * Returns the text kept under a key, or undefined when there is none. It
   * answers at once, since the frame stage reads a setting every frame.
   */
  readonly get: (key: string) => string | undefined;
  /** Keeps a text under a key, in place of the one it held. */
  readonly set: (key: string, text: string) => Effect.Effect<void, StoreFailed>;
}

/**
 * Where a program keeps its settings, which `Setting.layer` provides. A
 * frame or input system, a plugin's layer and code outside the game can
 * require it.
 *
 * **Gotchas**
 *
 * - A system of the tick, an action's handler and a plugin's setup don't
 *   compile with it.
 *
 * @category Services
 */
export class Store extends Context.Service<Store, StoreShape>()(
  "arcadekit/Setting.Store"
) {}

/**
 * Returns a layer that provides where settings are kept, such as
 * `Browser.settings(name)` in a page or `Setting.makeMemory()` in a test, as
 * `Setting.Store`.
 *
 *   Browser.runMain(
 *     Driver.run(Game, { hz: 60 }).pipe(
 *       Effect.provide(Setting.layer(Browser.settings("mygame")))
 *     )
 *   )
 *
 * @category Layers
 */
export const layer = (store: StoreShape): Layer.Layer<Store> =>
  Layer.succeed(Store, store);

/**
 * Makes a store of settings in memory, for a test or a tool, holding
 * `kept`, by key, to begin with. Two layers given one store share what it
 * holds, as two visits to a page share its storage.
 *
 * @category Testing
 */
export const makeMemory = (
  kept: Readonly<Record<string, string>> = {}
): StoreShape => {
  const texts = new Map(Object.entries(kept));
  return {
    get: (key) => texts.get(key),
    set: (key, text) =>
      Effect.sync(() => {
        texts.set(key, text);
      }),
  };
};

/**
 * Where a setting was to be kept couldn't keep it, such as a page whose
 * storage is full or turned off.
 *
 * @category Errors
 */
export class StoreFailed extends Data.TaggedError("SettingStoreFailed")<{
  /** The setting's key. */
  readonly key: string;
  readonly message: string;
}> {}

/**
 * A value that a setting's schema doesn't take: one given to `Setting.set`,
 * or what the store kept, read with `yield*`, when it isn't JSON or the
 * schema no longer takes it.
 *
 * @category Errors
 */
export class Invalid extends Data.TaggedError("SettingInvalid")<{
  /** The setting's key. */
  readonly key: string;
  /** What was wrong, as the schema reported it. */
  readonly message: string;
}> {}

/**
 * A setting's definition, as `Setting.define` makes it. It is an Effect, and
 * `yield*` returns its value: the one last set, kept in `Setting.Store`, or
 * its initial value when none was. It fails with `Setting.Invalid` when what
 * the store kept isn't JSON or the schema doesn't take it.
 *
 * @category Models
 */
export class Setting<A> extends Effectable.Class<A, Invalid, Store> {
  private effect: Effect.Effect<A, Invalid, Store> | undefined;

  constructor(
    /** What identifies the setting where it is kept, prefixed with its feature. */
    readonly key: string,
    /** The setting's schema, with its JSON form as the form it is kept in. */
    readonly codec: Schema.Codec<A, unknown>,
    /** Its value before it is first set. */
    readonly initial: A
  ) {
    super();
  }

  asEffect(): Effect.Effect<A, Invalid, Store> {
    if (this.effect === undefined) {
      const decode = Schema.decodeUnknownExit(
        Schema.fromJsonString(this.codec)
      );
      this.effect = Effect.flatMap(Effect.service(Store), (store) => {
        const text = store.get(this.key);
        if (text === undefined) {
          return Effect.succeed(this.initial);
        }
        const decoded = decode(text);
        return Exit.isSuccess(decoded)
          ? Effect.succeed(decoded.value)
          : Effect.fail(
              new Invalid({
                key: this.key,
                message: `The setting "${this.key}" keeps a value its schema doesn't take: ${said(Cause.squash(decoded.cause))}. Set it again, or read its initial value in its place with Effect.orElseSucceed.`,
              })
            );
      });
    }
    return this.effect;
  }
}

/**
 * Defines a setting from its key, the schema of its value, and the value it
 * has before it is first set.
 *
 *   const Keys = Setting.define(
 *     "game/Keys",
 *     Schema.Struct({ jump: Schema.String }),
 *     { jump: "Space" }
 *   )
 *
 * **Gotchas**
 *
 * - The key is what identifies the setting where it is kept, so prefix it
 *   with its feature. Two settings of one key read and write the same text.
 * - A kept value the schema no longer takes, after the schema changed, fails
 *   the read with `Setting.Invalid` until it is set again.
 *   `Effect.orElseSucceed(Keys, () => Keys.initial)` reads the initial value
 *   in its place.
 *
 * @category Constructors
 */
export const define = <S extends Schema.Codec<unknown, unknown>>(
  key: string,
  schema: S,
  initial: S["Type"]
): Setting<S["Type"]> =>
  new Setting(
    key,
    Schema.toCodecJson(schema) as Schema.Codec<S["Type"], unknown>,
    initial
  );

/**
 * Sets a setting's value and keeps it in `Setting.Store`: the setting has
 * the value from then on, in this run of the program and the next.
 *
 *   yield* Setting.set(Volume, 0.5)
 *
 * It fails with `Setting.Invalid` for a value its schema doesn't take, and
 * with `Setting.StoreFailed` when the store can't keep it. Either way, the
 * setting keeps the value it had.
 *
 * @category Combinators
 */
export const set: {
  <A>(
    value: A
  ): (setting: Setting<A>) => Effect.Effect<void, Invalid | StoreFailed, Store>;
  <A>(
    setting: Setting<A>,
    value: A
  ): Effect.Effect<void, Invalid | StoreFailed, Store>;
} = dual(
  2,
  Effect.fnUntraced(function* <A>(setting: Setting<A>, value: A) {
    const store = yield* Store;
    const json = Schema.encodeExit(setting.codec)(value);
    if (Exit.isFailure(json)) {
      return yield* new Invalid({
        key: setting.key,
        message: `The setting "${setting.key}" doesn't take this value: ${said(Cause.squash(json.cause))}`,
      });
    }
    yield* store.set(setting.key, JSON.stringify(json.value));
  })
);
