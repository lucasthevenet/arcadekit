/**
 * Push-puzzle's sound view: a view that plays a run's cues from the app's sounds.
 *
 * Each frame it compares the run's cue counters (`World.Cues`) with what it saw the frame before,
 * and plays one sound for each counter that rose, however far. It reads the run and never
 * changes it.
 *
 * Plain on purpose: a frame draws whole, sound included, before the browser shows it, so
 * `render` is a plain call; playing a sound is one too.
 */
import type { AudioSystem, CueSoundsOf } from "arcadekit/audio";
import type * as Game from "arcadekit/game/browser";

import type * as World from "../../world";
import type { PushPuzzleCueTable } from "../cue-table";

/** Cue counter name and the cue it plays, in play order. */
const CUES: readonly (readonly [
  keyof World.Cues,
  keyof CueSoundsOf<typeof PushPuzzleCueTable>,
])[] = [
  ["moves", "move"],
  ["pushes", "push"],
  ["holesFilled", "hole"],
  ["undos", "undo"],
  ["solved", "solved"],
];

/**
 * Makes a view that plays a run's cues through `audio`, with the app's `sounds`.
 *
 * The first frame of a run only takes its counts, so a view made mid-run plays nothing for what
 * came before; a new run, told apart by its state object, takes fresh counts, and so does the
 * same run after a frame with none.
 */
export const make = (
  audio: AudioSystem.AudioSystem,
  sounds: CueSoundsOf<typeof PushPuzzleCueTable>
): Game.View<World.Puzzle> => {
  /** The run heard last frame. */
  let heard: World.Puzzle | null = null;
  const seen: World.Cues = {
    moves: 0,
    pushes: 0,
    holesFilled: 0,
    undos: 0,
    solved: 0,
  };
  return {
    render: (puzzle) => {
      if (puzzle !== heard) {
        heard = puzzle;
        if (puzzle !== null) {
          Object.assign(seen, puzzle.cues);
        }
        return;
      }
      if (puzzle === null) {
        return;
      }
      for (const [cue, sound] of CUES) {
        if (puzzle.cues[cue] > seen[cue]) {
          audio.play(sounds[sound]);
        }
        seen[cue] = puzzle.cues[cue];
      }
    },
    dispose: () => {
      heard = null;
    },
  };
};
