/**
 * The app's save, declared: what it remembers between sessions, a record for each level.
 *
 * Storing, merging and handling broken storage are `arcadekit/save`'s; the declaration says what
 * a level's record holds (`LevelRecords`) and how two of them merge.
 */
import { Save } from "arcadekit/save";

import * as LevelRecords from "./level-records";

/**
 * This game's save. A write merges into what is stored, and `PushPuzzleSave.merge` is that merge
 * with no storage: the best of both sets of records, a level solved if either says so, with the
 * fewer moves. Neither its `read` nor its `write` fails: storage problems are logged and play
 * goes on.
 */
export class PushPuzzleSave extends Save("PushPuzzleSave", {
  storageKey: "arcadekit/push-puzzle/save",
  record: LevelRecords.LevelRecord,
  mergeRecord: (a, b) => {
    if (!a.solved) {
      return b;
    }
    if (!b.solved) {
      return a;
    }
    return { solved: true, bestMoves: Math.min(a.bestMoves, b.bestMoves) };
  },
}) {}
