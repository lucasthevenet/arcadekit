import type { RunSummary } from "@arcadekit/survivors";
import { Save } from "arcadekit/save";
import { Schema } from "effect";

// The save: what this game remembers between sessions, per hero id. It is UI
// state, not simulation state. The app reads it once at startup and writes it
// when a run ends, never per frame and never from a step. Storing, merging and
// handling broken storage is arcadekit/save; this file says what a hero's
// record holds and how two of them merge.

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

/**
 * This game's save. A write merges into what is stored, and `SurvivorsSave.merge` is that merge
 * with no storage: the best of both sets of records, the longer time, the more kills, and won if
 * either says so. Neither its `read` nor its `write` fails: storage problems are logged and play
 * goes on.
 */
export class SurvivorsSave extends Save("SurvivorsSave", {
  storageKey: "arcadekit/survivors/save",
  field: "heroes",
  record: HeroRecord,
  mergeRecord: (a, b) => ({
    bestTime: Math.max(a.bestTime, b.bestTime),
    mostKills: Math.max(a.mostKills, b.mostKills),
    won: a.won || b.won,
  }),
}) {}

/** One run as records: what a run's end writes into the save. */
export const run = (summary: RunSummary): HeroRecords => ({
  [summary.heroId]: {
    bestTime: summary.time,
    mostKills: summary.kills,
    won: summary.won,
  },
});

/** The records after the run in `summary`. A worse run keeps the best. */
export const withRun = (
  records: HeroRecords,
  summary: RunSummary
): HeroRecords => SurvivorsSave.merge(records, run(summary));
