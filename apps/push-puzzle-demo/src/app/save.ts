import * as BrowserKeyValueStore from "@effect/platform-browser/BrowserKeyValueStore";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";

// The save: what this game remembers between sessions, per level id. It is UI
// state, not simulation state. The app reads it once at startup and writes it
// when a level is solved, never per frame and never from a step.

/** One level's record. `bestMoves` only means something once `solved` is true. */
export const LevelRecord = Schema.Struct({
  solved: Schema.Boolean,
  bestMoves: Schema.Int,
});
export type LevelRecord = typeof LevelRecord.Type;

/** Records by level id. Ids the content no longer has are kept, but not shown. */
export const LevelRecords = Schema.Record(Schema.String, LevelRecord);
export type LevelRecords = typeof LevelRecords.Type;

export const emptyRecords: LevelRecords = {};

export const SAVE_KEY = "gamekit/push-puzzle/save";
/** Where a save that fails to decode (corrupt, or an unknown version) is copied before it is dropped. */
export const BACKUP_KEY = `${SAVE_KEY}/corrupt`;

/**
 * The stored shape, with its version. To change the shape, add the new
 * version here as a Union member and turn the old one into the new in `migrate`.
 */
const StoredSave = Schema.Struct({
  version: Schema.Literal(1),
  levels: LevelRecords,
});
type StoredSave = typeof StoredSave.Type;

const migrate = (stored: StoredSave): LevelRecords => stored.levels;

const toStored = (levels: LevelRecords): StoredSave => ({
  version: 1,
  levels,
});

const mergeRecord = (a: LevelRecord, b: LevelRecord): LevelRecord => {
  if (!a.solved) {
    return b;
  }
  if (!b.solved) {
    return a;
  }
  return { solved: true, bestMoves: Math.min(a.bestMoves, b.bestMoves) };
};

/** The best of both: a level is solved if either says so, with the fewer moves. */
export const mergeRecords = (a: LevelRecords, b: LevelRecords): LevelRecords =>
  Object.fromEntries([
    ...Object.entries(a).filter(([id]) => !Object.hasOwn(b, id)),
    ...Object.entries(b).map(([id, record]): [string, LevelRecord] => {
      const other = Object.hasOwn(a, id) ? a[id] : undefined;
      return [id, other === undefined ? record : mergeRecord(other, record)];
    }),
  ]);

/** The records after solving `levelId` in `moves` moves. A worse solve keeps the best. */
export const withSolve = (
  records: LevelRecords,
  levelId: string,
  moves: number
): LevelRecords =>
  mergeRecords(records, { [levelId]: { solved: true, bestMoves: moves } });

/** True when `moves` beats an earlier solve of `levelId`. A first solve has nothing to beat. */
export const isNewBest = (
  records: LevelRecords,
  levelId: string,
  moves: number
): boolean => {
  const earlier = Object.hasOwn(records, levelId)
    ? records[levelId]
    : undefined;
  return earlier !== undefined && earlier.solved && moves < earlier.bestMoves;
};

/** The save service. Neither method fails: storage problems are logged and play goes on. */
export interface SaveApi {
  /** The stored records. A missing save is empty. A corrupt or unknown-version one is backed up, logged and read as empty. */
  readonly load: Effect.Effect<LevelRecords>;
  /**
   * Records a solve. Re-reads the stored save first and keeps the best of both,
   * so a record another tab wrote isn't lost. Returns the merged records, even
   * when the write fails (that is logged and dropped).
   */
  readonly recordSolve: (
    levelId: string,
    moves: number
  ) => Effect.Effect<LevelRecords>;
}

export class Save extends Context.Service<Save, SaveApi>()(
  "push-puzzle-demo/Save"
) {}

/** The save service over whatever `KeyValueStore` is provided. */
export const SaveLayer = Layer.effect(
  Save,
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const saves = KeyValueStore.toSchemaStore(store, StoredSave);

    // Copies the unreadable value to the backup key and removes it, so it is backed up once.
    const backUp = Effect.gen(function* () {
      const raw = yield* store.get(SAVE_KEY);
      if (raw !== undefined) {
        yield* store.set(BACKUP_KEY, raw);
        yield* store.remove(SAVE_KEY);
      }
    });

    const load: Effect.Effect<LevelRecords> = saves.get(SAVE_KEY).pipe(
      Effect.map(Option.match({ onNone: () => emptyRecords, onSome: migrate })),
      Effect.catchTag("SchemaError", (error) =>
        Effect.logWarning(
          `The save can't be read. It is copied to ${BACKUP_KEY} and play starts from an empty save.`,
          error.message
        ).pipe(Effect.andThen(backUp), Effect.as(emptyRecords))
      ),
      Effect.catchTag("KeyValueStoreError", (error) =>
        Effect.logWarning(
          "The save can't be read. Play starts from an empty save.",
          error.message
        ).pipe(Effect.as(emptyRecords))
      )
    );

    const recordSolve = (levelId: string, moves: number) =>
      Effect.gen(function* () {
        const records = withSolve(yield* load, levelId, moves);
        yield* saves
          .set(SAVE_KEY, toStored(records))
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("The save can't be written.", error.message)
            )
          );
        return records;
      });

    return { load, recordSolve };
  })
);

/**
 * The browser's localStorage. If the browser won't give access to it, the
 * save lives in memory for this session instead, so the app still loads.
 */
export const BrowserSaveStorage = BrowserKeyValueStore.layerLocalStorage.pipe(
  Layer.catchCause((cause) =>
    Layer.merge(
      KeyValueStore.layerMemory,
      Layer.effectDiscard(
        Effect.logWarning(
          "localStorage isn't available. Saved progress lasts this session only.",
          cause
        )
      )
    )
  )
);
