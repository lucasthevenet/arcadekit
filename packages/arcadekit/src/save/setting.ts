import { Context, Layer, Result, Schema } from "effect";
import type { KeyValueStore } from "effect/persistence";

import { keep } from "./stored";
import type { Stored } from "./stored";

// A setting: one value an app keeps between sessions under its own storage key, apart from its
// save (ADR-0009): the player's volume and mute, their controls, whether they were offered the
// tutorial. The last write wins, unless the setting says how to merge.

/** The key string of the setting named `Name`. */
export type SettingId<Name extends string> = `arcadekit/save/Setting/${Name}`;

/**
 * The type-level identity of a setting's service: what `yield* MySetting` requires. It is the
 * type of the class's own values, so the class names it: `Layer.Layer<MySetting>`.
 */
export type SettingService<
  Name extends string,
  S extends Schema.Top,
> = Context.ServiceClass.Shape<SettingId<Name>, Stored<S["Type"]>>;

/** The class `Setting` returns: the key of the setting's service, and the Layer that provides it. */
export interface SettingClass<
  Name extends string,
  S extends Schema.Top,
> extends Context.ServiceClass<
  SettingService<Name, S>,
  SettingId<Name>,
  Stored<S["Type"]>
> {
  readonly kind: "Setting";
  readonly settingName: Name;
  readonly definition: SettingDefinition<S>;
  /**
   * Provides the setting over the app's `KeyValueStore`: `BrowserSaveStorage` in an app,
   * `KeyValueStore.layerMemory` in a test. Building it reads nothing.
   */
  readonly layer: Layer.Layer<
    SettingService<Name, S>,
    never,
    KeyValueStore.KeyValueStore
  >;
}

/** What `Setting` takes: where the value is stored, its Schema, and what it is before anything is stored. */
export interface SettingDefinition<S extends Schema.Top> {
  /**
   * Where the value is stored, apart from the save: such as `my-studio/<game>/settings`, a key
   * that no save or other setting has. Two declarations under one key overwrite each other, and
   * nothing refuses it. Not the class's `key`, which is its service's.
   */
  readonly storageKey: string;
  /** The value's Schema. It is stored as the JSON of its encoded side. */
  readonly schema: S;
  /**
   * The value before anything is stored, which a missing or unreadable one reads as. It must
   * pass `schema`, checks included, and is an instance if the Schema is a class.
   */
  readonly default: S["Type"];
  /**
   * What is stored and what is being written, as one: for a value that only grows, such as
   * "the tutorial was offered", so another tab's write isn't undone. `stored` is what `read`
   * gives, so it is the `default` when nothing is stored. Without a merge, a write replaces what
   * is stored: the last write wins, as it should for a volume. Leave the field out for that:
   * `merge: undefined` is refused. A literal in the value it builds keeps its type, and an
   * array written there is read-only, as in a save's `mergeRecord`.
   */
  readonly merge?: (stored: S["Type"], written: S["Type"]) => S["Type"];
}

/**
 * A setting an app keeps between sessions: one value under its own storage key, apart from its
 * save, such as the player's volume and mute, their controls, or whether they were offered the
 * tutorial. The declaration is where it is stored, its Schema, and its `default`. The class is
 * the key of the service that reads and writes it.
 *
 * ```ts
 * export class PushPuzzleAudioSettings extends Setting("PushPuzzleAudioSettings", {
 *   storageKey: "arcadekit/push-puzzle/settings",
 *   schema: AudioSettings,
 *   default: defaultAudioSettings,
 * }) {}
 *
 * // The app says where it is stored:
 * PushPuzzleAudioSettings.layer.pipe(Layer.provide(BrowserSaveStorage));
 *
 * // And a Command reads it, or writes it:
 * const setting = yield* PushPuzzleAudioSettings;
 * const settings = yield* setting.read;
 * yield* setting.write({ ...settings, muted: true });
 * ```
 *
 * `read` gives the stored value, and reads storage each time: a missing one is the `default`,
 * and so is one that can't be read, which is logged. `write(value)` replaces what is stored, so
 * the last write wins; a setting with a `merge` reads the stored value again and stores the two
 * as one. Neither fails: a write that storage refuses is logged and dropped.
 *
 * Throws when declared, for what the types let through: a `default` that its `schema` refuses,
 * such as a volume out of range.
 */
export const Setting = <
  const Name extends string,
  // `const`, so a literal in a value that `merge` builds keeps its type: `{ mode: "easy" }`.
  const S extends Schema.Top & {
    readonly DecodingServices: never;
    readonly EncodingServices: never;
  },
>(
  name: Name,
  definition: SettingDefinition<S>
): SettingClass<Name, S> => {
  const { storageKey, schema, merge } = definition;
  // The decoded side, so a Schema that transforms is not run: only its checks are.
  const checked = Schema.decodeUnknownResult(Schema.toType(schema))(
    definition.default
  );
  if (Result.isFailure(checked)) {
    throw new Error(
      `Setting "${name}" has a \`default\` that its \`schema\` refuses: ${checked.failure.message.replaceAll(/\s+/gu, " ")}. A missing setting reads as its \`default\` and no write could store it, so give one the schema takes: a value within its checks, and an instance if the schema is a class.`
    );
  }
  const Key = Context.Service<SettingService<Name, S>, Stored<S["Type"]>>()(
    `arcadekit/save/Setting/${name}` as SettingId<Name>
  );
  const layer = Layer.effect(
    Key,
    keep<S["Type"]>({
      label: `Setting "${name}"`,
      storageKey,
      schema,
      missing: definition.default,
      merge,
      backUp: false,
    })
  );
  return class extends Key {
    static readonly kind = "Setting" as const;
    static readonly settingName: Name = name;
    static readonly definition = definition;
    static readonly layer = layer;
  } as unknown as SettingClass<Name, S>;
};
