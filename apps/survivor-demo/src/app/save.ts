import * as BrowserKeyValueStore from "@effect/platform-browser/BrowserKeyValueStore";
import type { RunSummary } from "@gamekit/survivors";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";

// The save: what this game remembers between sessions, per hero id. It is UI
// state, not simulation state. The app reads it once at startup and writes it
// when a run ends, never per frame and never from a step.

/** One hero's record: the best of all its runs. */
export const HeroRecord = Schema.Struct({
  /** The longest time survived, in seconds. */
  bestTime: Schema.Number,
  mostKills: Schema.Int,
  /** True once a run with this hero was won. */
  won: Schema.Boolean,
});
export type HeroRecord = typeof HeroRecord.Type;

/** Records by hero id. Ids the content no longer has are kept, but not shown. */
export const HeroRecords = Schema.Record(Schema.String, HeroRecord);
export type HeroRecords = typeof HeroRecords.Type;

export const emptyRecords: HeroRecords = {};

export const SAVE_KEY = "gamekit/survivors/save";
/** Where a save that fails to decode (corrupt, or an unknown version) is copied before it is dropped. */
export const BACKUP_KEY = `${SAVE_KEY}/corrupt`;

/**
 * The stored shape, with its version. To change the shape, add the new
 * version here as a Union member and turn the old one into the new in `migrate`.
 */
const StoredSave = Schema.Struct({
  version: Schema.Literal(1),
  heroes: HeroRecords,
});
type StoredSave = typeof StoredSave.Type;

const migrate = (stored: StoredSave): HeroRecords => stored.heroes;

const toStored = (heroes: HeroRecords): StoredSave => ({
  version: 1,
  heroes,
});

const mergeRecord = (a: HeroRecord, b: HeroRecord): HeroRecord => ({
  bestTime: Math.max(a.bestTime, b.bestTime),
  mostKills: Math.max(a.mostKills, b.mostKills),
  won: a.won || b.won,
});

/** The best of both: the longer time, the more kills, and won if either says so. */
export const mergeRecords = (a: HeroRecords, b: HeroRecords): HeroRecords =>
  Object.fromEntries([
    ...Object.entries(a).filter(([id]) => !Object.hasOwn(b, id)),
    ...Object.entries(b).map(([id, record]): [string, HeroRecord] => {
      const other = Object.hasOwn(a, id) ? a[id] : undefined;
      return [id, other === undefined ? record : mergeRecord(other, record)];
    }),
  ]);

/** The records after the run in `summary`. A worse run keeps the best. */
export const withRun = (
  records: HeroRecords,
  summary: RunSummary
): HeroRecords =>
  mergeRecords(records, {
    [summary.heroId]: {
      bestTime: summary.time,
      mostKills: summary.kills,
      won: summary.won,
    },
  });

/** The save service. Neither method fails: storage problems are logged and play goes on. */
export interface SaveApi {
  /** The stored records. A missing save is empty. A corrupt or unknown-version one is backed up, logged and read as empty. */
  readonly load: Effect.Effect<HeroRecords>;
  /**
   * Records a run. Re-reads the stored save first and keeps the best of both,
   * so a record another tab wrote isn't lost. Returns the merged records, even
   * when the write fails (that is logged and dropped).
   */
  readonly recordRun: (summary: RunSummary) => Effect.Effect<HeroRecords>;
}

export class Save extends Context.Service<Save, SaveApi>()(
  "survivor-demo/Save"
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

    const load: Effect.Effect<HeroRecords> = saves.get(SAVE_KEY).pipe(
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

    const recordRun = (summary: RunSummary) =>
      Effect.gen(function* () {
        const records = withRun(yield* load, summary);
        yield* saves
          .set(SAVE_KEY, toStored(records))
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("The save can't be written.", error.message)
            )
          );
        return records;
      });

    return { load, recordRun };
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
