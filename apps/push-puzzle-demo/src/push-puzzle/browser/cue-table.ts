/**
 * Push-puzzle's cue table, declared: which of the app's sounds each of its cues plays.
 */
import { AudioSystem, CueTable } from "arcadekit/audio";

/**
 * Push-puzzle's cues, `move`, `push`, `hole`, `undo` and `solved`, each played by one of the app's
 * sounds. The genre ships no sound: the app owns the files, and gives each cue one.
 *
 * **When to use**
 *
 * In an app, to give the genre its sounds: `PushPuzzleCueTable.layer({ move: "move", ... })`, with
 * an id from the app's sound list for each cue.
 *
 * **Details**
 *
 * The engine's sound view plays a cue's sound when its cue counter rises (`World.Cues`). `hole`
 * plays with the `push` that filled the hole. The layer refuses a cue left out and a sound for
 * no cue.
 *
 * **Example** (An app's sounds)
 *
 * ```ts
 * import { PushPuzzleCueTable } from "#push-puzzle/browser";
 * import type { CueSoundsOf } from "arcadekit/audio";
 *
 * const sounds: CueSoundsOf<typeof PushPuzzleCueTable> = {
 *   move: "step",
 *   push: "scrape",
 *   hole: "thud",
 *   undo: "rewind",
 *   solved: "fanfare",
 * };
 * Object.keys(PushPuzzleCueTable.cues); // => ["move", "push", "hole", "undo", "solved"]
 * sounds.hole; // => "thud"
 * ```
 *
 * @category declarations
 */
export class PushPuzzleCueTable extends CueTable("PushPuzzleCueTable", {
  cues: {
    /** A turn that moved without pushing. */
    move: AudioSystem.SoundId,
    /** A turn that pushed a box, including into a hole. */
    push: AudioSystem.SoundId,
    /** A box falling into a hole. Plays with the push. */
    hole: AudioSystem.SoundId,
    undo: AudioSystem.SoundId,
    solved: AudioSystem.SoundId,
  },
}) {}
