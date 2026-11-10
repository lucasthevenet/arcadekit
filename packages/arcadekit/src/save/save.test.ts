import { Effect, Layer, Logger, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { describe, expect, it } from "vitest";

import { makeSaveStore, mergeRecords } from "./index";
import type { Records, SaveDefinition, SaveStore } from "./index";

// The save runs against an in-memory KeyValueStore, never real localStorage.
// Each test seeds the store, runs the save, and reads the store and the logs back.

const ScoreRecord = Schema.Struct({
  best: Schema.Int,
  cleared: Schema.Boolean,
});
type ScoreRecord = typeof ScoreRecord.Type;

const KEY = "arcadekit/test-game/save";
const BACKUP_KEY = `${KEY}/corrupt`;

const definition: SaveDefinition<ScoreRecord> = {
  key: KEY,
  field: "stages",
  record: ScoreRecord,
  mergeRecord: (a, b) => ({
    best: Math.max(a.best, b.best),
    cleared: a.cleared || b.cleared,
  }),
};

const failing = (method: "get" | "set") =>
  Layer.effect(
    KeyValueStore.KeyValueStore,
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      return {
        ...store,
        [method]: (key: string) =>
          Effect.fail(
            new KeyValueStore.KeyValueStoreError({
              message: "Storage is broken",
              method,
              key,
            })
          ),
      };
    })
  ).pipe(Layer.provide(KeyValueStore.layerMemory));

/** Runs `program` with the save over `storage`, after writing `stored` raw under the save key. */
const run = async <A>(
  program: (
    save: SaveStore<ScoreRecord>
  ) => Effect.Effect<A, never, KeyValueStore.KeyValueStore>,
  options: {
    readonly stored?: string;
    readonly storage?: Layer.Layer<KeyValueStore.KeyValueStore>;
  } = {}
) => {
  const warnings: unknown[] = [];
  const logger = Logger.make((log) => {
    warnings.push(log.message);
  });
  const result = await Effect.gen(function* () {
    if (options.stored !== undefined) {
      yield* (yield* KeyValueStore.KeyValueStore)
        .set(KEY, options.stored)
        .pipe(Effect.orDie);
    }
    return yield* program(yield* makeSaveStore(definition));
  }).pipe(
    Effect.provide(options.storage ?? KeyValueStore.layerMemory),
    Effect.provide(Logger.layer([logger])),
    Effect.runPromise
  );
  return { result, warnings };
};

const readRaw = (key: string) =>
  Effect.gen(function* () {
    return yield* (yield* KeyValueStore.KeyValueStore).get(key);
  }).pipe(Effect.orDie);

const stored = (stages: object) => JSON.stringify({ version: 1, stages });

describe("a save", () => {
  it("reads a missing save as empty", async () => {
    const { result, warnings } = await run((save) => save.load);
    expect(result).toStrictEqual({});
    expect(warnings).toStrictEqual([]);
  });

  it("reads what is stored", async () => {
    const { result } = await run((save) => save.load, {
      stored: stored({ one: { best: 3, cleared: true } }),
    });
    expect(result).toStrictEqual({ one: { best: 3, cleared: true } });
  });

  it("backs up a corrupt save once, logs it and reads it as empty", async () => {
    const { result, warnings } = await run(
      (save) =>
        Effect.all([save.load, readRaw(BACKUP_KEY), readRaw(KEY), save.load]),
      { stored: "{not json" }
    );
    expect(result).toStrictEqual([{}, "{not json", undefined, {}]);
    expect(warnings).toHaveLength(1);
  });

  it("treats a save of an unknown version like a corrupt one", async () => {
    const raw = JSON.stringify({ version: 99, stages: {} });
    const { result, warnings } = await run(
      (save) => Effect.all([save.load, readRaw(BACKUP_KEY)]),
      { stored: raw }
    );
    expect(result).toStrictEqual([{}, raw]);
    expect(warnings).toHaveLength(1);
  });

  it("logs a store that can't be read and reads it as empty", async () => {
    const { result, warnings } = await run((save) => save.load, {
      storage: failing("get"),
    });
    expect(result).toStrictEqual({});
    expect(warnings).toHaveLength(1);
  });

  it("writes the records under the key, versioned, in the game's field", async () => {
    const { result } = await run((save) =>
      Effect.andThen(
        save.merge({ one: { best: 3, cleared: false } }),
        Effect.all([save.load, readRaw(KEY)])
      )
    );
    expect(result).toStrictEqual([
      { one: { best: 3, cleared: false } },
      stored({ one: { best: 3, cleared: false } }),
    ]);
  });

  it("merges each write with the stored records through the game's merge", async () => {
    const { result } = await run((save) =>
      Effect.andThen(
        Effect.all([
          save.merge({ one: { best: 3, cleared: true } }),
          save.merge({ one: { best: 5, cleared: false } }),
        ]),
        save.load
      )
    );
    expect(result).toStrictEqual({ one: { best: 5, cleared: true } });
  });

  it("merges with what another tab wrote, keeping ids the content no longer has", async () => {
    const { result } = await run(
      (save) => save.merge({ one: { best: 4, cleared: false } }),
      {
        stored: stored({
          one: { best: 2, cleared: true },
          two: { best: 7, cleared: false },
          "old-stage": { best: 1, cleared: true },
        }),
      }
    );
    expect(result).toStrictEqual({
      one: { best: 4, cleared: true },
      two: { best: 7, cleared: false },
      "old-stage": { best: 1, cleared: true },
    });
  });

  it("logs and drops a failed write, and still returns the records", async () => {
    const { result, warnings } = await run(
      (save) => save.merge({ one: { best: 3, cleared: false } }),
      { storage: failing("set") }
    );
    expect(result).toStrictEqual({ one: { best: 3, cleared: false } });
    expect(warnings).toHaveLength(1);
  });
});

describe(mergeRecords, () => {
  const merge = mergeRecords(definition.mergeRecord);

  it("keeps ids only one side has and merges ids both sides have", () => {
    const a: Records<ScoreRecord> = {
      one: { best: 2, cleared: true },
      two: { best: 7, cleared: false },
    };
    const b: Records<ScoreRecord> = {
      one: { best: 4, cleared: false },
      three: { best: 1, cleared: false },
    };
    expect(merge(a, b)).toStrictEqual({
      two: { best: 7, cleared: false },
      one: { best: 4, cleared: true },
      three: { best: 1, cleared: false },
    });
  });
});
