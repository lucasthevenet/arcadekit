import type { RunSummary } from "@arcadekit/survivors";
import { Effect, Layer } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Story } from "foldkit";
import { describe, expect, it } from "vitest";

import { SaveRun } from "./commands";
import { Message } from "./message";
import type { Model } from "./model";
import { SurvivorsSave, run as runRecords } from "./save";
import { init, update } from "./update";

// The app's save over an in-memory KeyValueStore, never real localStorage.
// Missing, corrupt and unknown-version saves, the merge with another tab and
// failed writes are arcadekit/save's tests; these cover this game's record,
// its merge rule and its key.

const run = <A>(
  program: Effect.Effect<A, never, SurvivorsSave | KeyValueStore.KeyValueStore>
) =>
  program.pipe(
    Effect.provide(
      SurvivorsSave.layer.pipe(Layer.provideMerge(KeyValueStore.layerMemory))
    ),
    Effect.runPromise
  );

const readRaw = (key: string) =>
  Effect.gen(function* () {
    return yield* (yield* KeyValueStore.KeyValueStore).get(key);
  }).pipe(Effect.orDie);

const load = Effect.gen(function* () {
  return yield* (yield* SurvivorsSave).read;
});
const recordRun = (summary: RunSummary) =>
  Effect.gen(function* () {
    return yield* (yield* SurvivorsSave).write(runRecords(summary));
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
  it("remembers a run's time, kills and outcome, under a versioned key", async () => {
    const result = await run(
      Effect.andThen(
        recordRun(runSummary("bolter", { time: 95, kills: 40, won: false })),
        Effect.all([load, readRaw(SurvivorsSave.definition.storageKey)])
      )
    );
    expect(result).toStrictEqual([
      { bolter: { bestTime: 95, mostKills: 40, won: false } },
      stored({ bolter: { bestTime: 95, mostKills: 40, won: false } }),
    ]);
  });

  it("keeps the best of each field across runs", async () => {
    const result = await run(
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
