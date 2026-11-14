/**
 * Settings: one value an app keeps between sessions under its own storage key, apart from its
 * save, such as the player's volume and mute, their controls, or whether they were
 * offered the tutorial.
 *
 * `Setting` is a declaration with a service, as `Save` is: the class is the service's key, its
 * `layer` provides the service over the app's `KeyValueStore`, and the service is a `Stored`. The
 * last write wins, unless the setting says how what is stored and what is written merge.
 *
 * @since 0.7.0
 */
import { Context, Layer, Result, Schema } from "effect";
import type { KeyValueStore } from "effect/persistence";

import { keep } from "./internal/keep";
import type * as Stored from "./stored";

/**
 * The key string of the setting named `Name`.
 *
 * **When to use**
 *
 * Rarely: it is part of the setting's type, which a game names by its class.
 *
 * **Example** (A setting's key)
 *
 * ```ts
 * import { Setting } from "arcadekit/save";
 * import type { SettingId } from "arcadekit/save";
 * import { Schema } from "effect";
 *
 * class RaceVolume extends Setting("RaceVolume", {
 *   storageKey: "my-studio/race/volume",
 *   schema: Schema.Number,
 *   default: 0.8,
 * }) {}
 *
 * const key: SettingId<"RaceVolume"> = RaceVolume.key;
 * key; // => "arcadekit/save/Setting/RaceVolume"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type SettingId<Name extends string> = `arcadekit/save/Setting/${Name}`;

/**
 * The type-level identity of a setting's service: what `yield* MySetting` requires. It is the
 * type of the class's own values, so the class names it: `Layer.Layer<MySetting>`.
 *
 * **When to use**
 *
 * Rarely: name the class instead, as a requirement (`Effect.Effect<A, E, RaceVolume>`) or a
 * Layer's service (`Layer.Layer<RaceVolume>`).
 *
 * **Example** (The class names its service)
 *
 * ```ts
 * import { Setting } from "arcadekit/save";
 * import type { SettingService } from "arcadekit/save";
 * import { Layer, Schema } from "effect";
 * import { KeyValueStore } from "effect/persistence";
 *
 * class RaceVolume extends Setting("RaceVolume", {
 *   storageKey: "my-studio/race/volume",
 *   schema: Schema.Number,
 *   default: 0.8,
 * }) {}
 *
 * const layer: Layer.Layer<SettingService<"RaceVolume", Schema.Number>> = RaceVolume.layer.pipe(
 *   Layer.provide(KeyValueStore.layerMemory)
 * );
 * const same: Layer.Layer<RaceVolume> = layer;
 * Layer.isLayer(same); // => true
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type SettingService<
  Name extends string,
  S extends Schema.Top,
> = Context.ServiceClass.Shape<SettingId<Name>, Stored.Stored<S["Type"]>>;

/**
 * The class `Setting` returns: the key of the setting's service, and the `layer` that provides
 * it.
 *
 * **When to use**
 *
 * To type a value that is some setting's class, as a host that takes one does. A game names its
 * own class.
 *
 * **Example** (What the class holds)
 *
 * ```ts
 * import { Setting } from "arcadekit/save";
 * import type { SettingClass } from "arcadekit/save";
 * import { Schema } from "effect";
 *
 * class RaceVolume extends Setting("RaceVolume", {
 *   storageKey: "my-studio/race/volume",
 *   schema: Schema.Number,
 *   default: 0.8,
 * }) {}
 *
 * const declared: SettingClass<"RaceVolume", Schema.Number> = RaceVolume;
 * declared.kind; // => "Setting"
 * declared.settingName; // => "RaceVolume"
 * declared.definition.default; // => 0.8
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface SettingClass<
  Name extends string,
  S extends Schema.Top,
> extends Context.ServiceClass<
  SettingService<Name, S>,
  SettingId<Name>,
  Stored.Stored<S["Type"]>
> {
  readonly kind: "Setting";
  readonly settingName: Name;
  readonly definition: SettingDefinition<S>;
  /**
   * Provides the setting over the app's `KeyValueStore`: `BrowserSaveStorage.layer` in an app,
   * `KeyValueStore.layerMemory` in a test. Building it reads nothing.
   */
  readonly layer: Layer.Layer<
    SettingService<Name, S>,
    never,
    KeyValueStore.KeyValueStore
  >;
}

/**
 * What `Setting` takes: where the value is stored, its Schema, what it is before anything is
 * stored, and, for a value that only grows, how what is stored and what is written merge. A
 * declaration keeps it as its `definition`.
 *
 * **When to use**
 *
 * Read it from a declared setting's `definition`, as an options screen does that puts a value
 * back to its `default`.
 *
 * **Details**
 *
 * `storageKey` is a key apart from the save, such as `my-studio/<game>/settings`, that no save or
 * other setting has: two declarations under one key overwrite each other, and nothing refuses it.
 * It is not the class's `key`, which is its service's. The value is stored as the JSON of its
 * Schema's encoded side. If `schema` is a Schema class, a value is an instance of it, in what
 * `write` is given and in what `merge` returns: the types take a plain object there, and its write
 * is logged and dropped.
 *
 * **Example** (Putting a setting back to its default)
 *
 * ```ts
 * import { Setting } from "arcadekit/save";
 * import type { SettingDefinition } from "arcadekit/save";
 * import { Schema } from "effect";
 *
 * class RaceVolume extends Setting("RaceVolume", {
 *   storageKey: "my-studio/race/volume",
 *   schema: Schema.Number,
 *   default: 0.8,
 * }) {}
 *
 * const definition: SettingDefinition<Schema.Number> = RaceVolume.definition;
 * definition.default; // => 0.8
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface SettingDefinition<S extends Schema.Top> {
  /** Where the value is stored, apart from the save: a key that no save or other setting has. */
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
   * `merge: undefined` is refused where `exactOptionalPropertyTypes` is on, and means the same
   * where it is off. A literal in the value it builds keeps its type, and an array written
   * there is read-only, as in a save's `mergeRecord`.
   */
  readonly merge?: (stored: S["Type"], written: S["Type"]) => S["Type"];
}

/**
 * Declares a setting: one value an app keeps between sessions under its own storage key, apart
 * from its save, such as the player's volume and mute, their controls, or whether they were
 * offered the tutorial. The declaration is where it is stored, its Schema, and its `default`. The
 * class is the key of the service that reads and writes it.
 *
 * **When to use**
 *
 * For a choice the player makes once and expects to find again (a volume, the controls), and for
 * progress that is no record by id (the tutorial was offered). Records by a level's or a hero's
 * id are a `Save`.
 *
 * **Details**
 *
 * The app provides it with `layer`, over its `KeyValueStore`, and anything reads or writes it
 * through the service: `(yield* MySetting).read`. `read` gives the stored value, and reads storage
 * each time: a missing one is the `default`, and so is one that can't be read, which is logged and
 * left where it is. `write(value)` replaces what is stored, so the last write wins; a setting with
 * a `merge` reads the stored value again and stores the two as one. Its writes run one at a time.
 * Neither fails: a write that storage refuses is logged and dropped. A trace shows each read as
 * `<Name>.read` and each write as `<Name>.write`.
 *
 * **Example** (Declaring a setting, then reading it before and after a write)
 *
 * ```ts
 * import { Setting } from "arcadekit/save";
 * import { Effect, Layer, Schema } from "effect";
 * import { KeyValueStore } from "effect/persistence";
 *
 * class RaceControls extends Setting("RaceControls", {
 *   storageKey: "my-studio/race/controls",
 *   schema: Schema.Struct({ invertY: Schema.Boolean }),
 *   default: { invertY: false },
 * }) {}
 *
 * const program = Effect.gen(function* () {
 *   const controls = yield* RaceControls;
 *   const before = yield* controls.read;
 *   yield* controls.write({ invertY: true });
 *   return [before, yield* controls.read];
 * });
 * const layer = RaceControls.layer.pipe(Layer.provide(KeyValueStore.layerMemory));
 * Effect.runSync(program.pipe(Effect.provide(layer))); // => [{ invertY: false }, { invertY: true }]
 * ```
 *
 * Throws when declared, for what the types let through: a `default` that its `schema` refuses,
 * such as a volume out of range.
 *
 * @category declarations
 * @since 0.7.0
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
  // The decoded side, so a Schema that transforms is not run: only its checks are.
  const checked = Schema.decodeUnknownResult(Schema.toType(definition.schema))(
    definition.default
  );
  if (Result.isFailure(checked)) {
    throw new Error(
      `Setting "${name}" has a \`default\` that its \`schema\` refuses: ${checked.failure.message.replaceAll(/\s+/gu, " ")}. A missing setting reads as its \`default\` and no write could store it, so give one the schema takes: a value within its checks, and an instance if the schema is a class.`
    );
  }
  const Key = Context.Service<
    SettingService<Name, S>,
    Stored.Stored<S["Type"]>
  >()(`arcadekit/save/Setting/${name}` as SettingId<Name>);
  const layer = Layer.effect(
    Key,
    keep<S["Type"]>({
      kind: "Setting",
      name,
      storageKey: definition.storageKey,
      schema: definition.schema,
      missing: definition.default,
      merge: definition.merge,
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
