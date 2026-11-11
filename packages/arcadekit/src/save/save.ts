import { Context, Effect, Layer, Schema } from "effect";
import type { KeyValueStore } from "effect/persistence";

import { keep } from "./stored";
import type { Stored } from "./stored";

// A save: what a game keeps between sessions, as records by id (a level's best move count, a
// hero's best time). It is UI state, not simulation state. The game says what one record holds
// and how two records for the same id merge; this module keeps the stored shape, and stored.ts
// what to do when storage fails.

/** Records by id. Ids the content no longer has are kept. */
export type Records<A> = Readonly<Record<string, A>>;

/** The key string of the save named `Name`. */
export type SaveId<Name extends string> = `arcadekit/save/Save/${Name}`;

/**
 * The type-level identity of a save's service: what `yield* MySave` requires. It is the type of
 * the class's own values, so the class names it: `Layer.Layer<MySave>`.
 */
export type SaveService<
  Name extends string,
  S extends Schema.Top,
> = Context.ServiceClass.Shape<SaveId<Name>, Stored<Records<S["Type"]>>>;

/** The class `Save` returns: the key of the save's service, its plain merge and the Layer that provides it. */
export interface SaveClass<
  Name extends string,
  S extends Schema.Top,
> extends Context.ServiceClass<
  SaveService<Name, S>,
  SaveId<Name>,
  Stored<Records<S["Type"]>>
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
   * Provides the save over the app's `KeyValueStore`: `BrowserSaveStorage` in an app,
   * `KeyValueStore.layerMemory` in a test. Building it reads nothing.
   */
  readonly layer: Layer.Layer<
    SaveService<Name, S>,
    never,
    KeyValueStore.KeyValueStore
  >;
}

/** What `Save` takes: where the save is stored, what one record holds, and how two records merge. */
export interface SaveDefinition<
  S extends Schema.Top,
  Field extends string = string,
> {
  /**
   * Where the save is stored: one key per game, such as `my-studio/<game>/save`, that no other
   * save or setting has. Two declarations under one key overwrite each other, and nothing
   * refuses it. A save that can't be read is copied to `<storageKey>/corrupt`. Not the class's
   * `key`, which is its service's.
   */
  readonly storageKey: string;
  /**
   * The field of the stored save that holds the records, such as `levels` or `heroes`: the
   * stored shape is `{ version: 1, [field]: records }`, so it can't be `version`.
   */
  readonly field: Field;
  /** One record's Schema. */
  readonly record: S;
  /**
   * The record merge: two records for the same id, as one. Usually the best of both. Its
   * records are typed from `record`, and a literal in the record it builds keeps its type. The
   * price: an array written in that record is read-only, so for a Schema of a mutable array,
   * name the array first (`const ids = [...a.ids, ...b.ids]; return { ids };`).
   */
  readonly mergeRecord: (a: S["Type"], b: S["Type"]) => S["Type"];
}

/**
 * Refuses `field: "version"` in the types, on its own line: the stored save keeps its version
 * there. A field the types can't see (a `string` held in a variable) is refused when declared.
 */
type RefuseVersionField<Field extends string> = [Field] extends ["version"]
  ? { readonly field: never }
  : unknown;

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
 * The stored shape is `{ version: 1, [field]: records }`. Every save is at version 1 so far.
 * When a game first changes its record shape, add the new version here as a Union member with a
 * way to turn the old into the new.
 */
interface StoredSave<A> {
  readonly version: 1;
  readonly records: Records<A>;
}

const storedSave = <A>(
  field: string,
  record: Schema.ConstraintCodec<A, unknown>
): Schema.ConstraintCodec<StoredSave<A>, unknown> =>
  Schema.Struct({
    version: Schema.Literal(1),
    records: Schema.Record(Schema.String, record),
  }).pipe(Schema.encodeKeys({ records: field }));

/**
 * What a game keeps between sessions, as records by id: a level's best move count, a hero's best
 * time. The declaration is where the save is stored, what one record holds, and how two records
 * for one id merge. The class is the key of the service that reads and writes it.
 *
 * ```ts
 * export class PushPuzzleSave extends Save("PushPuzzleSave", {
 *   storageKey: "arcadekit/push-puzzle/save",
 *   field: "levels",
 *   record: LevelRecord,
 *   mergeRecord: (a, b) => (a.bestMoves <= b.bestMoves ? a : b),
 * }) {}
 *
 * // The app says where it is stored:
 * PushPuzzleSave.layer.pipe(Layer.provide(BrowserSaveStorage));
 *
 * // And a Command reads it, or writes one level's record into it:
 * const save = yield* PushPuzzleSave;
 * const records = yield* save.read;
 * const merged = yield* save.write({ [levelId]: { bestMoves: moves } });
 * ```
 *
 * A write merges, and never replaces: `write(records)` reads the stored save again, merges
 * `records` into it by id through `mergeRecord`, stores the result and gives every record after
 * it, so the other ids, and a record another tab wrote, aren't lost. `read` gives the stored
 * records, and reads storage each time: a missing save is empty, and one that can't be decoded
 * is copied to `<storageKey>/corrupt`, logged and read as empty. Neither fails: a write that
 * storage refuses is logged and dropped, and still gives the merged records.
 * `PushPuzzleSave.merge(a, b)` is the same merge with no storage, for an app's `update`.
 *
 * Throws when declared, for what the types let through: a `field` named `version`.
 */
export const Save = <
  const Name extends string,
  // `const`, so a literal in a record that `mergeRecord` builds keeps its type: `{ medal: "gold" }`.
  const S extends Schema.Top & {
    readonly DecodingServices: never;
    readonly EncodingServices: never;
  },
  const Field extends string,
>(
  name: Name,
  definition: SaveDefinition<S, Field> & RefuseVersionField<Field>
): SaveClass<Name, S> => {
  const { storageKey, field } = definition;
  if (field === "version") {
    throw new Error(
      `Save "${name}" keeps its records in the field "version", where the stored save keeps its version. Name the field for what the records are, such as "levels" or "heroes".`
    );
  }
  const Key = Context.Service<
    SaveService<Name, S>,
    Stored<Records<S["Type"]>>
  >()(`arcadekit/save/Save/${name}` as SaveId<Name>);
  const merge = mergeById<S["Type"]>(definition.mergeRecord);
  const layer = Layer.effect(
    Key,
    Effect.map(
      keep<StoredSave<S["Type"]>>({
        label: `Save "${name}"`,
        storageKey,
        schema: storedSave(field, definition.record),
        missing: { version: 1, records: {} },
        merge: (stored, written) => ({
          version: 1,
          records: merge(stored.records, written.records),
        }),
        backUp: true,
      }),
      (stored): Stored<Records<S["Type"]>> => ({
        read: stored.read.pipe(Effect.map((save) => save.records)),
        write: (records) =>
          stored
            .write({ version: 1, records })
            .pipe(Effect.map((save) => save.records)),
      })
    )
  );
  return class extends Key {
    static readonly kind = "Save" as const;
    static readonly saveName: Name = name;
    static readonly definition = definition;
    static readonly merge = merge;
    static readonly layer = layer;
  } as unknown as SaveClass<Name, S>;
};
