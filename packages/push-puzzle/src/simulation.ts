import * as Game from "arcadekit/game";

import { Hud, LevelSolved } from "./events";
import { PushPuzzleInput, createPuzzle, hudSample, step } from "./world";

/**
 * The push-puzzle genre's rules: what `Game.Loop` steps in a browser, a Worker, on a server or
 * in a test. `./browser`'s `PushPuzzleEngine` adds the input, the view and the sound.
 */
export class PushPuzzle extends Game.Simulation("PushPuzzle", {
  input: PushPuzzleInput,
  events: [LevelSolved],
  create: createPuzzle,
  step,
  // The HUD changes only on a turn, so it's sent right after a turn, and never in between.
  sample: { event: Hud, version: (puzzle) => puzzle.turns, read: hudSample },
}) {}
