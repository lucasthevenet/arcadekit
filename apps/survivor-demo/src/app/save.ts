/**
 * The app's save, declared: what it remembers between sessions, a record for each hero.
 *
 * Storing, merging and handling broken storage are `arcadekit/save`'s; the declaration says what
 * a hero's record holds (`HeroRecords`) and how two of them merge.
 */
import { Save } from "arcadekit/save";

import * as HeroRecords from "./hero-records";

/**
 * This game's save. A write merges into what is stored, and `SurvivorsSave.merge` is that merge
 * with no storage: the best of both sets of records, the longer time, the more kills, and won if
 * either says so. Neither its `read` nor its `write` fails: storage problems are logged and play
 * goes on.
 */
export class SurvivorsSave extends Save("SurvivorsSave", {
  storageKey: "arcadekit/survivors/save",
  record: HeroRecords.HeroRecord,
  mergeRecord: (a, b) => ({
    bestTime: Math.max(a.bestTime, b.bestTime),
    mostKills: Math.max(a.mostKills, b.mostKills),
    won: a.won || b.won,
  }),
}) {}
