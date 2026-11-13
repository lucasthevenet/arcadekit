/**
 * Saves: what a game keeps between sessions, as records by id (a level's best move count, a
 * hero's best time).
 *
 * `Save` is a declaration with a service: the class is the service's key, its `layer` provides
 * the service over the app's `KeyValueStore`, and the service is a `Stored`, whose `write` merges
 * into what it could read. A save is UI state, not simulation state: an app reads it at startup
 * and writes it when a run or a level ends, never from a step. The game says what one record holds
 * and how two records for one id merge; this module keeps the stored shape.
 *
 * @since 0.7.0
 */
import { Context, Layer, Schema, SchemaTransformation } from "effect";
import type { KeyValueStore } from "effect/persistence";

import { keep } from "./internal/keep";
import type * as Stored from "./stored";

/**
 * A save's records, by id: a level's or a hero's. Ids the content no longer has are kept.
 *
 * **When to use**
 *
 * Name it for what a save's `read` and `write` give, as a helper that takes the records does. A
 * game's records are usually its own Schema's, `Schema.Record(Schema.String, LevelRecord)`, which
 * is the same type.
 *
 * **Example** (A save's records)
 *
 * ```ts
 * import { Save } from "arcadekit/save";
 * import type { Records } from "arcadekit/save";
 * import { Schema } from "effect";
 *
 * const Lap = Schema.Struct({ bestLap: Schema.Number });
 * class RaceSave extends Save("RaceSave", {
 *   storageKey: "my-studio/race/save",
 *   record: Lap,
 *   mergeRecord: (a, b) => (a.bestLap <= b.bestLap ? a : b),
 * }) {}
 *
 * const records: Records<typeof Lap.Type> = { oval: { bestLap: 61.2 } };
 * RaceSave.merge(records, { hills: { bestLap: 80.5 } }); // => { oval: { bestLap: 61.2 }, hills: { bestLap: 80.5 } }
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Records<A> = Readonly<Record<string, A>>;

/**
 * The key string of the save named `Name`.
 *
 * **When to use**
 *
 * Rarely: it is part of the save's type, which a game names by its class.
 *
 * **Example** (A save's key)
 *
 * ```ts
 * import { Save } from "arcadekit/save";
 * import type { SaveId } from "arcadekit/save";
 * import { Schema } from "effect";
 *
 * class RaceSave extends Save("RaceSave", {
 *   storageKey: "my-studio/race/save",
 *   record: Schema.Struct({ bestLap: Schema.Number }),
 *   mergeRecord: (a, b) => (a.bestLap <= b.bestLap ? a : b),
 * }) {}
 *
 * const key: SaveId<"RaceSave"> = RaceSave.key;
 * key; // => "arcadekit/save/Save/RaceSave"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type SaveId<Name extends string> = `arcadekit/save/Save/${Name}`;

/**
 * The type-level identity of a save's service: what `yield* MySave` requires. It is the type of
 * the class's own values, so the class names it: `Layer.Layer<MySave>`.
 *
 * **When to use**
 *
 * Rarely: name the class instead, as a requirement (`Effect.Effect<A, E, RaceSave>`) or a Layer's
 * service (`Layer.Layer<RaceSave>`).
 *
 * **Example** (The class names its service)
 *
 * ```ts
 * import { Save } from "arcadekit/save";
 * import type { SaveService } from "arcadekit/save";
 * import { Layer, Schema } from "effect";
 * import { KeyValueStore } from "effect/persistence";
 *
 * const Lap = Schema.Struct({ bestLap: Schema.Number });
 * class RaceSave extends Save("RaceSave", {
 *   storageKey: "my-studio/race/save",
 *   record: Lap,
 *   mergeRecord: (a, b) => (a.bestLap <= b.bestLap ? a : b),
 * }) {}
 *
 * const layer: Layer.Layer<SaveService<"RaceSave", typeof Lap>> = RaceSave.layer.pipe(
 *   Layer.provide(KeyValueStore.layerMemory)
 * );
 * const same: Layer.Layer<RaceSave> = layer;
 * Layer.isLayer(same); // => true
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type SaveService<
  Name extends string,
  S extends Schema.Top,
> = Context.ServiceClass.Shape<SaveId<Name>, Stored.Stored<Records<S["Type"]>>>;

/**
 * The class `Save` returns: the key of the save's service, its plain `merge` and the `layer` that
 * provides it.
 *
 * **When to use**
 *
 * To type a value that is some save's class, as a host that takes one does. A game names its own
 * class.
 *
 * **Example** (What the class holds)
 *
 * ```ts
 * import { Save } from "arcadekit/save";
 * import type { SaveClass } from "arcadekit/save";
 * import { Schema } from "effect";
 *
 * const Lap = Schema.Struct({ bestLap: Schema.Number });
 * class RaceSave extends Save("RaceSave", {
 *   storageKey: "my-studio/race/save",
 *   record: Lap,
 *   mergeRecord: (a, b) => (a.bestLap <= b.bestLap ? a : b),
 * }) {}
 *
 * const declared: SaveClass<"RaceSave", typeof Lap> = RaceSave;
 * declared.kind; // => "Save"
 * declared.saveName; // => "RaceSave"
 * declared.definition.storageKey; // => "my-studio/race/save"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface SaveClass<
  Name extends string,
  S extends Schema.Top,
> extends Context.ServiceClass<
  SaveService<Name, S>,
  SaveId<Name>,
  Stored.Stored<Records<S["Type"]>>
> {
  readonly kind: "Save";
  readonly saveName: Name;
  readonly definition: SaveDefinition<S>;
  /**
   * Two sets of records as one, by id: an id only one side has is kept, and an id both have
   * goes through the save's `mergeRecord`. It is what a write does with the stored records, as
   * a plain function with no storage, so an app's `update` shows the new records before the
   * write is back.
   */
  readonly merge: (
    a: Records<S["Type"]>,
    b: Records<S["Type"]>
  ) => Records<S["Type"]>;
  /**
   * Provides the save over the app's `KeyValueStore`: `BrowserSaveStorage.layer` in an app,
   * `KeyValueStore.layerMemory` in a test. Building it reads nothing.
   */
  readonly layer: Layer.Layer<
    SaveService<Name, S>,
    never,
    KeyValueStore.KeyValueStore
  >;
}

/**
 * What `Save` takes: where the save is stored, what one record holds, and how two records for one
 * id merge. A declaration keeps it as its `definition`.
 *
 * **When to use**
 *
 * Read it from a declared save's `definition`, as a test does that reads what was stored under
 * its key.
 *
 * **Details**
 *
 * `storageKey` is one key per game, such as `my-studio/<game>/save`, that no other save or setting
 * has: two declarations under one key overwrite each other, and nothing refuses it. It is not the
 * class's `key`, which is its service's. If `record` is a Schema class, a record is an instance of
 * it (`new LevelRecord({ ... })`), in what `write` is given and in what `mergeRecord` returns: the
 * types take a plain object there, and its write is logged and dropped.
 *
 * **Example** (Where a save is stored)
 *
 * ```ts
 * import { Save } from "arcadekit/save";
 * import type { SaveDefinition } from "arcadekit/save";
 * import { Schema } from "effect";
 *
 * const Lap = Schema.Struct({ bestLap: Schema.Number });
 * class RaceSave extends Save("RaceSave", {
 *   storageKey: "my-studio/race/save",
 *   record: Lap,
 *   mergeRecord: (a, b) => (a.bestLap <= b.bestLap ? a : b),
 * }) {}
 *
 * const definition: SaveDefinition<typeof Lap> = RaceSave.definition;
 * definition.storageKey; // => "my-studio/race/save"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface SaveDefinition<S extends Schema.Top> {
  /**
   * Where the save is stored: one key per game, that no other save or setting has. A save that
   * can't be read is copied to `<storageKey>/corrupt`.
   */
  readonly storageKey: string;
  /** One record's Schema. */
  readonly record: S;
  /**
   * The record merge: two records for the same id, as one. Usually the best of both. On a
   * write, `a` is the stored record and `b` the one written. Its records are typed from
   * `record`, and a literal in the record it builds keeps its type. The price: an array written
   * in that record is read-only, so for a Schema of a mutable array, name the array first
   * (`const ids = [...a.ids, ...b.ids]; return { ids };`).
   */
  readonly mergeRecord: (a: S["Type"], b: S["Type"]) => S["Type"];
}

/** Merges two sets of records by id, each id both have through `mergeRecord(a, b)`. */
const mergeById =
  <A>(mergeRecord: (a: A, b: A) => A) =>
  (a: Records<A>, b: Records<A>): Records<A> =>
    Object.fromEntries([
      ...Object.entries(a).filter(([id]) => !Object.hasOwn(b, id)),
      ...Object.entries(b).map(([id, record]): [string, A] => {
        const other = Object.hasOwn(a, id) ? a[id] : undefined;
        return [id, other === undefined ? record : mergeRecord(other, record)];
      }),
    ]);

/**
 * The stored save, `{ version: 1, records }`, decoded to its records. Every save is at version 1
 * so far: one stored at another version fails to decode, so it is backed up. When a stored shape
 * first changes, add the new version here as a Union member with a way to turn the old into the
 * new.
 */
const storedSave = <A>(
  record: Schema.ConstraintCodec<A, unknown>
): Schema.ConstraintCodec<Records<A>, unknown> =>
  Schema.Struct({
    version: Schema.Literal(1),
    records: Schema.Record(Schema.String, record),
  }).pipe(
    Schema.decodeTo(
      Schema.Record(Schema.String, Schema.toType(record)),
      SchemaTransformation.transform({
        decode: (save) => save.records,
        encode: (records) => ({ version: 1 as const, records }),
      })
    )
  );

/**
 * Declares a game's save: what it keeps between sessions, as records by id, such as a level's best
 * move count or a hero's best time. The declaration is where the save is stored, what one record
 * holds, and how two records for one id merge. The class is the key of the service that reads and
 * writes it.
 *
 * **When to use**
 *
 * For what an app shows of past runs: a level select's best moves, a hero select's best times. It
 * is read at startup and written when a run or a level ends. One value kept apart from it, such as
 * the player's volume, is a `Setting`.
 *
 * **Details**
 *
 * The app provides it with `layer`, over its `KeyValueStore`, and anything reads or writes it
 * through the service: `(yield* MySave).read`. `write(records)` reads the stored save again,
 * merges `records` into it by id through `mergeRecord`, stores the result and gives every record
 * after it, so the other ids, and a record another tab wrote, aren't lost; its writes run one at a
 * time. `read` gives the stored records, and reads storage each time. Neither fails: a missing save
 * is empty, one that can't be decoded is copied to `<storageKey>/corrupt`, logged and read as
 * empty, and a write that storage refuses is logged and dropped, and still gives the merged
 * records. `MySave.merge(a, b)` is the same merge with no storage, for an app's `update`. The stored
 * save is `{ "version": 1, "records": { ... } }`. A trace shows each read as `<Name>.read` and each
 * write as `<Name>.write`.
 *
 * **Example** (Declaring a save, writing two laps and reading it)
 *
 * ```ts
 * import { Save } from "arcadekit/save";
 * import { Effect, Layer, Schema } from "effect";
 * import { KeyValueStore } from "effect/persistence";
 *
 * // The app declares its save:
 * class RaceSave extends Save("RaceSave", {
 *   storageKey: "my-studio/race/save",
 *   record: Schema.Struct({ bestLap: Schema.Number }),
 *   mergeRecord: (a, b) => (a.bestLap <= b.bestLap ? a : b),
 * }) {}
 *
 * // Says where it is stored (`BrowserSaveStorage.layer` in a browser):
 * const layer = RaceSave.layer.pipe(Layer.provide(KeyValueStore.layerMemory));
 *
 * // And a Command writes a lap into it, or reads it:
 * const program = Effect.gen(function* () {
 *   const save = yield* RaceSave;
 *   yield* save.write({ oval: { bestLap: 61.2 } });
 *   yield* save.write({ oval: { bestLap: 64 }, hills: { bestLap: 80.5 } });
 *   return yield* save.read;
 * });
 * const records = Effect.runSync(program.pipe(Effect.provide(layer)));
 * records; // => { oval: { bestLap: 61.2 }, hills: { bestLap: 80.5 } }
 * ```
 *
 * @category declarations
 * @since 0.7.0
 */
export const Save = <
  const Name extends string,
  // `const`, so a literal in a record that `mergeRecord` builds keeps its type: `{ medal: "gold" }`.
  const S extends Schema.Top & {
    readonly DecodingServices: never;
    readonly EncodingServices: never;
  },
>(
  name: Name,
  definition: SaveDefinition<S>
): SaveClass<Name, S> => {
  const Key = Context.Service<
    SaveService<Name, S>,
    Stored.Stored<Records<S["Type"]>>
  >()(`arcadekit/save/Save/${name}` as SaveId<Name>);
  const merge = mergeById<S["Type"]>(definition.mergeRecord);
  const layer = Layer.effect(
    Key,
    keep<Records<S["Type"]>>({
      kind: "Save",
      name,
      storageKey: definition.storageKey,
      schema: storedSave(definition.record),
      missing: {},
      merge,
      backUp: true,
    })
  );
  return class extends Key {
    static readonly kind = "Save" as const;
    static readonly saveName: Name = name;
    static readonly definition = definition;
    static readonly merge = merge;
    static readonly layer = layer;
  } as unknown as SaveClass<Name, S>;
};
