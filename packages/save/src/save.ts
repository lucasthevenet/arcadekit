import { Effect, Option, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";

// A save: what a game keeps between sessions, as records by id (a level's best
// move count, a hero's best time). It is UI state, not simulation state. The
// game says what one record holds and how two records for the same id merge;
// this module keeps the stored shape, the keys, and what to do when storage
// fails, so neither method fails.

/** Records by id. Ids the content no longer has are kept. */
export type Records<R> = Readonly<Record<string, R>>;

/** What a game passes in: where its save lives, what one record holds, and how two records merge. */
export interface SaveDefinition<R, E = R> {
  /** The game's storage key, such as `gamekit/<game>/save`. A save that can't be read is copied to `backupKey(key)`. */
  readonly key: string;
  /** The field of the stored save that holds the records, such as `levels` or `heroes`. */
  readonly field: string;
  /** One record's Schema. */
  readonly record: Schema.Codec<R, E>;
  /** Two records for the same id, as one. Usually the best of both. */
  readonly mergeRecord: (a: R, b: R) => R;
}

/** A game's save over a `KeyValueStore`. Neither method fails: storage problems are logged and play goes on. */
export interface SaveStore<R> {
  /** The stored records. A missing save is empty. A corrupt or unknown-version one is backed up, logged and read as empty. */
  readonly load: Effect.Effect<Records<R>>;
  /**
   * Merges `records` into the save. Re-reads the stored save first, so a record
   * another tab wrote isn't lost. Returns the merged records, even when the
   * write fails (that is logged and dropped).
   */
  readonly merge: (records: Records<R>) => Effect.Effect<Records<R>>;
}

/** Where a save that fails to decode (corrupt, or an unknown version) is copied before it is dropped. */
export const backupKey = (key: string): string => `${key}/corrupt`;

/**
 * Merges two sets of records by id. Ids only one side has are kept; ids on
 * both sides go through `mergeRecord(a, b)`.
 */
export const mergeRecords =
  <R>(mergeRecord: (a: R, b: R) => R) =>
  (a: Records<R>, b: Records<R>): Records<R> =>
    Object.fromEntries([
      ...Object.entries(a).filter(([id]) => !Object.hasOwn(b, id)),
      ...Object.entries(b).map(([id, record]): [string, R] => {
        const other = Object.hasOwn(a, id) ? a[id] : undefined;
        return [id, other === undefined ? record : mergeRecord(other, record)];
      }),
    ]);

/**
 * The stored shape is `{ version: 1, [field]: records }`. Every save is at
 * version 1 so far. When a game first changes its record shape, add the new
 * version here as a Union member with a way to turn the old into the new.
 */
interface StoredSave<R> {
  readonly version: 1;
  readonly records: Records<R>;
}

const storedSchema = <R, E>(
  field: string,
  record: Schema.Codec<R, E>
): Schema.Codec<StoredSave<R>, unknown> =>
  Schema.Struct({
    version: Schema.Literal(1),
    records: Schema.Record(Schema.String, record),
  }).pipe(Schema.encodeKeys({ records: field }));

/** Builds a game's save over the `KeyValueStore` in context. */
export const makeSaveStore = <R, E>(
  definition: SaveDefinition<R, E>
): Effect.Effect<SaveStore<R>, never, KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const { key } = definition;
    const backup = backupKey(key);
    const empty: Records<R> = {};
    const merge = mergeRecords(definition.mergeRecord);
    const store = yield* KeyValueStore.KeyValueStore;
    const saves = KeyValueStore.toSchemaStore(
      store,
      storedSchema(definition.field, definition.record)
    );

    // Copies the unreadable value to the backup key and removes it, so it is backed up once.
    const backUp = Effect.gen(function* () {
      const raw = yield* store.get(key);
      if (raw !== undefined) {
        yield* store.set(backup, raw);
        yield* store.remove(key);
      }
    });

    const load: Effect.Effect<Records<R>> = saves.get(key).pipe(
      Effect.map(
        Option.match({
          onNone: () => empty,
          onSome: (stored) => stored.records,
        })
      ),
      Effect.catchTag("SchemaError", (error) =>
        Effect.logWarning(
          `The save can't be read. It is copied to ${backup} and play starts from an empty save.`,
          error.message
        ).pipe(Effect.andThen(backUp), Effect.as(empty))
      ),
      Effect.catchTag("KeyValueStoreError", (error) =>
        Effect.logWarning(
          "The save can't be read. Play starts from an empty save.",
          error.message
        ).pipe(Effect.as(empty))
      )
    );

    return {
      load,
      merge: (records) =>
        Effect.gen(function* () {
          const merged = merge(yield* load, records);
          yield* saves
            .set(key, { version: 1, records: merged })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("The save can't be written.", error.message)
              )
            );
          return merged;
        }),
    };
  });
