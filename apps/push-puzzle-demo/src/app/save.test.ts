import { Effect, Layer, Logger } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Story } from "foldkit";
import { describe, expect, it } from "vitest";

import { SaveSolve } from "./commands";
import { Message } from "./message";
import { Phase } from "./model";
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
const recordSolve = (levelId: string, moves: number) =>
  Effect.gen(function* () {
    return yield* (yield* Save).recordSolve(levelId, moves);
  });

const stored = (levels: object) => JSON.stringify({ version: 1, levels });

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
    const raw = JSON.stringify({ version: 99, levels: {} });
    const { result, warnings } = await run(
      Effect.all([load, readRaw(BACKUP_KEY)]),
      { stored: raw }
    );
    expect(result).toStrictEqual([{}, raw]);
    expect(warnings).toHaveLength(1);
  });

  it("remembers a solve with its moves, under a versioned key", async () => {
    const { result } = await run(
      Effect.andThen(
        recordSolve("first-push", 6),
        Effect.all([load, readRaw(SAVE_KEY)])
      )
    );
    expect(result).toStrictEqual([
      { "first-push": { solved: true, bestMoves: 6 } },
      stored({ "first-push": { solved: true, bestMoves: 6 } }),
    ]);
  });

  it("keeps the best when a later solve takes more moves", async () => {
    const { result } = await run(
      Effect.andThen(
        Effect.all([
          recordSolve("first-push", 6),
          recordSolve("first-push", 9),
        ]),
        load
      )
    );
    expect(result).toStrictEqual({
      "first-push": { solved: true, bestMoves: 6 },
    });
  });

  it("raises the best when a later solve takes fewer moves", async () => {
    const { result } = await run(
      Effect.andThen(
        Effect.all([
          recordSolve("first-push", 9),
          recordSolve("first-push", 6),
        ]),
        load
      )
    );
    expect(result).toStrictEqual({
      "first-push": { solved: true, bestMoves: 6 },
    });
  });

  it("merges with what another tab wrote, keeping ids the content no longer has", async () => {
    const { result } = await run(recordSolve("first-push", 8), {
      stored: stored({
        "first-push": { solved: true, bestMoves: 6 },
        "mind-the-gap": { solved: true, bestMoves: 13 },
        "old-level": { solved: true, bestMoves: 3 },
      }),
    });
    expect(result).toStrictEqual({
      "first-push": { solved: true, bestMoves: 6 },
      "mind-the-gap": { solved: true, bestMoves: 13 },
      "old-level": { solved: true, bestMoves: 3 },
    });
  });

  it("logs and drops a failed write, and still returns the records", async () => {
    const { result, warnings } = await run(recordSolve("first-push", 6), {
      storage: failingWrites,
    });
    expect(result).toStrictEqual({
      "first-push": { solved: true, bestMoves: 6 },
    });
    expect(warnings).toHaveLength(1);
  });
});

const solvedOnce: Model = {
  ...init().model,
  phase: Phase.Playing(),
  levels: [{ id: "first-push", name: "First push" }],
  levelId: "first-push",
  records: { "first-push": { solved: true, bestMoves: 8 } },
};

const solvedPhase = (model: Model) =>
  model.phase._tag === "Solved" ? model.phase : undefined;

describe("solving a level", () => {
  it("says new best when the moves beat the saved best, and takes in the saved records", () => {
    Story.story(
      update,
      Story.given(solvedOnce),
      Story.message(Message.GotLevelSolved({ moves: 6 })),
      Story.model((model) => {
        expect(solvedPhase(model)?.isNewBest).toBe(true);
        expect(model.records["first-push"]?.bestMoves).toBe(6);
      }),
      Story.Command.expectExact(SaveSolve({ levelId: "first-push", moves: 6 })),
      Story.Command.resolve(
        SaveSolve,
        Message.SavedSolve({
          records: {
            "first-push": { solved: true, bestMoves: 6 },
            "two-doors": { solved: true, bestMoves: 36 },
          },
        })
      ),
      Story.model((model) =>
        expect(model.records["two-doors"]?.bestMoves).toBe(36)
      )
    );
  });

  it("doesn't say new best for a worse solve, and keeps the best", () => {
    Story.story(
      update,
      Story.given(solvedOnce),
      Story.message(Message.GotLevelSolved({ moves: 9 })),
      Story.model((model) => {
        expect(solvedPhase(model)?.isNewBest).toBe(false);
        expect(model.records["first-push"]?.bestMoves).toBe(8);
      }),
      Story.Command.resolve(
        SaveSolve,
        Message.SavedSolve({ records: solvedOnce.records })
      )
    );
  });
});
