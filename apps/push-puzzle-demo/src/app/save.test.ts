import { Effect, Layer } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Story } from "foldkit";
import { describe, expect, it } from "vitest";

import { SaveSolve } from "./commands";
import { Message } from "./message";
import { Phase } from "./model";
import type { Model } from "./model";
import { SAVE_KEY, Save, SaveLayer, mergeRecords } from "./save";
import { init, update } from "./update";

// The app's save over an in-memory KeyValueStore, never real localStorage.
// Missing, corrupt and unknown-version saves, the merge with another tab and
// failed writes are @gamekit/save's tests; these cover this game's record,
// its merge rule and its key.

const run = <A>(
  program: Effect.Effect<A, never, Save | KeyValueStore.KeyValueStore>
) =>
  program.pipe(
    Effect.provide(
      SaveLayer.pipe(Layer.provideMerge(KeyValueStore.layerMemory))
    ),
    Effect.runPromise
  );

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
  it("remembers a solve with its moves, under a versioned key", async () => {
    const result = await run(
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
    const result = await run(
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
    const result = await run(
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

  it("takes a solved record over an unsolved one, whatever its moves", () => {
    expect(
      mergeRecords(
        { "first-push": { solved: true, bestMoves: 12 } },
        { "first-push": { solved: false, bestMoves: 0 } }
      )
    ).toStrictEqual({ "first-push": { solved: true, bestMoves: 12 } });
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
