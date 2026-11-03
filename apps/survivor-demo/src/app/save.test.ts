import type { RunSummary } from "@gamekit/survivors";
import { Effect, Layer, Logger } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Story } from "foldkit";
import { describe, expect, it } from "vitest";

import { SaveRun } from "./commands";
import { Message } from "./message";
import type { Model } from "./model";
import { BACKUP_KEY, SAVE_KEY, Save, SaveLayer } from "./save";
import { init, update } from "./update";

// The save service runs against an in-memory KeyValueStore, never real localStorage.
// Each test seeds the store, runs the service, and reads the store and the logs back.

const failingWrites = Layer.effect(
  KeyValueStore.KeyValueStore,
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    return {
      ...store,
      set: (key: string) =>
        Effect.fail(
          new KeyValueStore.KeyValueStoreError({
            message: "Storage is full",
            method: "set",
            key,
          })
        ),
    };
  })
).pipe(Layer.provide(KeyValueStore.layerMemory));

/** Runs `program` with the save over `storage`, after writing `stored` raw under the save key. */
const run = async <A>(
  program: Effect.Effect<A, never, Save | KeyValueStore.KeyValueStore>,
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
        .set(SAVE_KEY, options.stored)
        .pipe(Effect.orDie);
    }
    return yield* program;
  }).pipe(
    Effect.provide(
      SaveLayer.pipe(
        Layer.provideMerge(options.storage ?? KeyValueStore.layerMemory)
      )
    ),
    Effect.provide(Logger.layer([logger])),
    Effect.runPromise
  );
  return { result, warnings };
};

const readRaw = (key: string) =>
  Effect.gen(function* () {
    return yield* (yield* KeyValueStore.KeyValueStore).get(key);
  }).pipe(Effect.orDie);

const load = Effect.gen(function* () {
  return yield* (yield* Save).load;
});
const recordRun = (summary: RunSummary) =>
  Effect.gen(function* () {
    return yield* (yield* Save).recordRun(summary);
  });

const runSummary = (
  heroId: string,
  { time, kills, won }: { time: number; kills: number; won: boolean }
): RunSummary => ({
  won,
  heroId,
  heroName: heroId,
  time,
  kills,
  level: 1,
});

const stored = (heroes: object) => JSON.stringify({ version: 1, heroes });

describe("the save", () => {
  it("reads a missing save as empty", async () => {
    const { result, warnings } = await run(load);
    expect(result).toStrictEqual({});
    expect(warnings).toStrictEqual([]);
  });

  it("backs up a corrupt save once, logs it and reads it as empty", async () => {
    const { result, warnings } = await run(
      Effect.all([load, readRaw(BACKUP_KEY), readRaw(SAVE_KEY), load]),
      { stored: "{not json" }
    );
    expect(result).toStrictEqual([{}, "{not json", undefined, {}]);
    expect(warnings).toHaveLength(1);
  });

  it("treats a save of an unknown version like a corrupt one", async () => {
    const raw = JSON.stringify({ version: 99, heroes: {} });
    const { result, warnings } = await run(
      Effect.all([load, readRaw(BACKUP_KEY)]),
      { stored: raw }
    );
    expect(result).toStrictEqual([{}, raw]);
    expect(warnings).toHaveLength(1);
  });

  it("remembers a run's time, kills and outcome, under a versioned key", async () => {
    const { result } = await run(
      Effect.andThen(
        recordRun(runSummary("bolter", { time: 95, kills: 40, won: false })),
        Effect.all([load, readRaw(SAVE_KEY)])
      )
    );
    expect(result).toStrictEqual([
      { bolter: { bestTime: 95, mostKills: 40, won: false } },
      stored({ bolter: { bestTime: 95, mostKills: 40, won: false } }),
    ]);
  });

  it("keeps the best of each field across runs", async () => {
    const { result } = await run(
      Effect.andThen(
        Effect.all([
          recordRun(runSummary("bolter", { time: 300, kills: 20, won: true })),
          recordRun(runSummary("bolter", { time: 95, kills: 40, won: false })),
        ]),
        load
      )
    );
    expect(result).toStrictEqual({
      bolter: { bestTime: 300, mostKills: 40, won: true },
    });
  });

  it("merges with what another tab wrote, keeping ids the content no longer has", async () => {
    const { result } = await run(
      recordRun(runSummary("bolter", { time: 120, kills: 10, won: false })),
      {
        stored: stored({
          bolter: { bestTime: 100, mostKills: 50, won: true },
          burner: { bestTime: 60, mostKills: 12, won: false },
          "old-hero": { bestTime: 30, mostKills: 3, won: false },
        }),
      }
    );
    expect(result).toStrictEqual({
      bolter: { bestTime: 120, mostKills: 50, won: true },
      burner: { bestTime: 60, mostKills: 12, won: false },
      "old-hero": { bestTime: 30, mostKills: 3, won: false },
    });
  });

  it("logs and drops a failed write, and still returns the records", async () => {
    const { result, warnings } = await run(
      recordRun(runSummary("bolter", { time: 95, kills: 40, won: false })),
      { storage: failingWrites }
    );
    expect(result).toStrictEqual({
      bolter: { bestTime: 95, mostKills: 40, won: false },
    });
    expect(warnings).toHaveLength(1);
  });
});

const playedOnce: Model = {
  ...init().model,
  records: { bolter: { bestTime: 100, mostKills: 50, won: false } },
};

describe("ending a run", () => {
  it("records the run, saves it, and takes in the saved records", () => {
    const summary = runSummary("bolter", { time: 120, kills: 30, won: false });
    Story.story(
      update,
      Story.given(playedOnce),
      Story.message(Message.GotRunEnded({ summary })),
      Story.model((model) =>
        expect(model.records["bolter"]).toStrictEqual({
          bestTime: 120,
          mostKills: 50,
          won: false,
        })
      ),
      Story.Command.expectExact(SaveRun({ summary })),
      Story.Command.resolve(
        SaveRun,
        Message.SavedRun({
          records: {
            bolter: { bestTime: 120, mostKills: 50, won: false },
            burner: { bestTime: 60, mostKills: 12, won: true },
          },
        })
      ),
      Story.model((model) => expect(model.records["burner"]?.won).toBe(true))
    );
  });
});
