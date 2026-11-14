/**
 * Hero records: what the app remembers of each hero between sessions, by hero id.
 *
 * They are UI state, not simulation state: the app reads them once at startup and writes a run
 * into them when it ends, never per frame and never from a step. `SurvivorsSave` keeps them, and
 * its record merge says how two records of one hero become one.
 *
 * Plain on purpose: Schemas, and the pure function `update` and `SaveRun` call.
 */
import type { Hero } from "@arcadekit/survivors";
import { Schema } from "effect";

/** One hero's record: the best of all its runs. */
export const HeroRecord = Schema.Struct({
  /** The longest time survived, in seconds. */
  bestTime: Schema.Number,
  /** The most kills of one run. */
  mostKills: Schema.Int,
  /** True once a run with this hero was won. */
  won: Schema.Boolean,
});

/** One hero's record, decoded. */
export type HeroRecord = typeof HeroRecord.Type;

/** Records by hero id. Ids the content no longer has are kept, but not shown. */
export const HeroRecords = Schema.Record(Schema.String, HeroRecord);

/** Records by hero id, decoded: what the Model holds and the save reads and writes. */
export type HeroRecords = typeof HeroRecords.Type;

/** No records: what the Model holds until the save is read. */
export const empty: HeroRecords = {};

/** How a run ended for its hero, as records: what a run's end merges into the Model and writes into the save. */
export const fromSummary = (summary: Hero.Summary): HeroRecords => ({
  [summary.heroId]: {
    bestTime: summary.time,
    mostKills: summary.kills,
    won: summary.won,
  },
});
