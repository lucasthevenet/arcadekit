import { AudioSystem, CueTable } from "arcadekit/audio";
import type { CueSoundsOf } from "arcadekit/audio";
import type * as Game from "arcadekit/game/browser";

import type { Puzzle, PushPuzzleCues } from "../world";

/**
 * Push-puzzle's cue table: which of the app's sounds each of its cues plays (ADR-0014). The app
 * gives the sounds, `PushPuzzleCueTable.layer({ move: "move", ... })`: it owns the sound files,
 * and the genre ships none.
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

/** The app's sound for each cue: what the sound view plays from. */
type PushPuzzleSounds = CueSoundsOf<typeof PushPuzzleCueTable>;

/** Cue counter name and the sound it plays, in play order. */
const CUES: readonly (readonly [
  keyof PushPuzzleCues,
  keyof PushPuzzleSounds,
])[] = [
  ["moves", "move"],
  ["pushes", "push"],
  ["holesFilled", "hole"],
  ["undos", "undo"],
  ["solved", "solved"],
];

/**
 * Plays a Puzzle's sounds (ADR-0014). Each frame it compares the cue counters with what it
 * saw last frame and plays one sound per counter that went up, however far it went. The first
 * frame of a run only takes the counts, so mounting mid-run plays nothing. Reads the
 * simulation; never changes it.
 */
export class PushPuzzleSoundView implements Game.View<Puzzle> {
  private readonly audio: AudioSystem.AudioSystem;
  private readonly sounds: PushPuzzleSounds;
  /** The run heard last frame. A new run (a restart, another level) takes fresh counts. */
  private puzzle: Puzzle | null = null;
  private readonly seen: PushPuzzleCues = {
    moves: 0,
    pushes: 0,
    holesFilled: 0,
    undos: 0,
    solved: 0,
  };

  constructor(audio: AudioSystem.AudioSystem, sounds: PushPuzzleSounds) {
    this.audio = audio;
    this.sounds = sounds;
  }

  render(puzzle: Puzzle | null): void {
    if (puzzle !== this.puzzle) {
      this.puzzle = puzzle;
      if (puzzle !== null) {
        Object.assign(this.seen, puzzle.cues);
      }
      return;
    }
    if (puzzle === null) {
      return;
    }
    for (const [cue, sound] of CUES) {
      if (puzzle.cues[cue] > this.seen[cue]) {
        this.audio.play(this.sounds[sound]);
      }
      this.seen[cue] = puzzle.cues[cue];
    }
  }

  dispose(): void {
    this.puzzle = null;
  }
}
