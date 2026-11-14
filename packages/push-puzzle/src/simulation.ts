/**
 * Push-puzzle's rules, declared: what `Game.Loop` steps in a browser, a Worker, on a server or in
 * a test.
 *
 * The declaration names the parts the `World` module holds: the step input, how a run starts,
 * the step, and the HUD's sample. `PushPuzzleEngine` (`@arcadekit/push-puzzle/browser`) adds the
 * input, the view and the sound.
 */
import * as Game from "arcadekit/game";

import { Hud, LevelSolved } from "./events";
import * as World from "./world";

/**
 * Push-puzzle's rules: a Sokoban-like tile map played in turns, with undo and holes. A run is one
 * attempt at one level, and reports `LevelSolved` when every goal has a box.
 *
 * **When to use**
 *
 * To step a run without a browser: a replay makes a loop of it (`Game.makeLoop(PushPuzzle)`), and
 * a test a scenario (`Scenario.make(PushPuzzle)`). An app reads its events through
 * `PushPuzzle.match`, and its state's type is `World.Puzzle`.
 *
 * **Details**
 *
 * Its config is a `World.Config` and its step input a `World.Input`. It has no randomness and no
 * command. The `Hud` sample is sent at a run's start and after each turn, and never in between.
 *
 * **Example** (Hearing a run in a loop)
 *
 * ```ts
 * import { PushPuzzle, PuzzleContent } from "@arcadekit/push-puzzle";
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(PuzzleContent.PuzzleContent)({
 *   levels: [{ id: "push", name: "Push", rows: ["#####", "#@$.#", "#####"] }],
 * });
 * const heard: string[] = [];
 * const loop = Game.makeLoop(PushPuzzle);
 * loop.subscribe(
 *   PushPuzzle.match({
 *     Hud: ({ boxesLeft }) => heard.push(`${boxesLeft} left`),
 *     LevelSolved: ({ moves }) => heard.push(`solved in ${moves}`),
 *   })
 * );
 * loop.start({ content, levelId: "push" }, 0, 0);
 * loop.frame({ read: () => ({ held: "right", pressed: "right", undo: false }) }, { steps: 1 }, 0);
 * heard; // => ["1 left", "solved in 1", "0 left"]
 * ```
 *
 * @category declarations
 */
export class PushPuzzle extends Game.Simulation("PushPuzzle", {
  input: World.Input,
  events: [LevelSolved],
  create: World.make,
  step: World.step,
  // The HUD changes only on a turn, so it's sent right after a turn, and never in between.
  sample: {
    event: Hud,
    version: (puzzle) => puzzle.turns,
    read: World.hudSample,
  },
}) {}
