import type { GameSimulation } from "arcadekit/runtime";

import type { PushPuzzleEvent } from "./events";
import { createPuzzle, hudSample, step } from "./world";
import type { Puzzle, PushPuzzleConfig, PushPuzzleInput } from "./world";

/**
 * The push-puzzle genre as an arcadekit/runtime simulation: what a GameLoop steps, in a browser,
 * a Worker, on a server or in a test. `./browser`'s `makePushPuzzleGame` adds input, the view and sound.
 */
export const pushPuzzleSimulation: GameSimulation<
  PushPuzzleConfig,
  Puzzle,
  PushPuzzleInput,
  PushPuzzleEvent
> = {
  stepSeconds: 1 / 60,
  create: createPuzzle,
  step,
  drainEvents: (puzzle) => puzzle.events.drain(),
  // The HUD changes only on a turn, so it's sent right after a turn, and never in between.
  sample: {
    version: (puzzle) => puzzle.turns,
    read: (puzzle) => ({ type: "hud", hud: hudSample(puzzle) }),
  },
};
