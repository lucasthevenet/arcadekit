import { Effect, Layer } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Story } from "foldkit";
import { describe, expect, it } from "vitest";

import { LoadSave, SaveSolve } from "./commands";
import { Message } from "./message";
import { Phase } from "./model";
import type { Model } from "./model";
import { PushPuzzleSave } from "./save";
import { init, update } from "./update";

// The app's save over an in-memory KeyValueStore, never real localStorage, read
// and written by the Commands the app runs. Missing, corrupt and unknown-version
// saves, the merge with another tab and failed writes are arcadekit/save's
// tests; these cover this game's record, its merge rule and its key.

/** The save's storage key, written out: moving it would leave every stored save behind. */
const SAVE_KEY = "arcadekit/push-puzzle/save";

const run = <A>(
  program: Effect.Effect<A, never, PushPuzzleSave | KeyValueStore.KeyValueStore>
) =>
  program.pipe(
    Effect.provide(
      PushPuzzleSave.layer.pipe(Layer.provideMerge(KeyValueStore.layerMemory))
    ),
    Effect.runPromise
  );

const readRaw = (key: string) =>
  Effect.gen(function* () {
    return yield* (yield* KeyValueStore.KeyValueStore).get(key);
  }).pipe(Effect.orDie);

/** The records the app reads at startup. */
const read = LoadSave().effect.pipe(Effect.map(({ records }) => records));
/** Writes a solve as the app does when a level is solved, and gives the records it reports. */
const writeSolve = (levelId: string, moves: number) =>
  SaveSolve({ levelId, moves }).effect.pipe(
    Effect.map(({ records }) => records)
  );

const stored = (levels: object) => JSON.stringify({ version: 1, levels });

describe("the save", () => {
  it("remembers a solve with its moves, under a versioned key", async () => {
    const result = await run(
      Effect.andThen(
        writeSolve("first-push", 6),
        Effect.all([read, readRaw(SAVE_KEY)])
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
        Effect.all([writeSolve("first-push", 6), writeSolve("first-push", 9)]),
        read
      )
    );
    expect(result).toStrictEqual({
      "first-push": { solved: true, bestMoves: 6 },
    });
  });

  it("raises the best when a later solve takes fewer moves", async () => {
    const result = await run(
      Effect.andThen(
        Effect.all([writeSolve("first-push", 9), writeSolve("first-push", 6)]),
        read
      )
    );
    expect(result).toStrictEqual({
      "first-push": { solved: true, bestMoves: 6 },
    });
  });

  it("takes a solved record over an unsolved one, whatever its moves", () => {
    expect(
      PushPuzzleSave.merge(
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
