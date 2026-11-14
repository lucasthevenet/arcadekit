/**
 * Push-puzzle's events: what a run reports to the app.
 *
 * Each is a declaration: a class that is also its own Schema, so an app uses it in its Model and
 * its Messages, and a field added here reaches the app. A run reports `LevelSolved` from its step,
 * and `Hud` is its sample.
 */
import * as Game from "arcadekit/game";
import { Schema } from "effect";

/**
 * What the HUD shows: the moves made, and the goals that have no box on them yet. It is the run's
 * sample, reported at the start of a run and after every turn.
 *
 * **When to use**
 *
 * In an app's Model and Messages, to show the HUD: the engine reports it, and
 * `PushPuzzle.match` turns it into a Message.
 *
 * **Example** (A HUD's values)
 *
 * ```ts
 * import { Hud } from "@arcadekit/push-puzzle";
 *
 * const hud = new Hud({ moves: 3, boxesLeft: 1 });
 * [hud._tag, hud.moves, hud.boxesLeft]; // => ["Hud", 3, 1]
 * ```
 *
 * @category declarations
 */
export class Hud extends Game.Event("Hud", {
  moves: Schema.Int,
  /** Goals that have no box on them yet. */
  boxesLeft: Schema.Int,
}) {}

/**
 * The level is solved: every goal has a box on it, after this many moves. The run takes no turn
 * after it.
 *
 * **When to use**
 *
 * In an app's Messages, to show the solved screen and keep the level's best move count.
 *
 * **Details**
 *
 * It is reported once per run, on the move that puts a box on the last goal. `moves` counts the
 * moves made, minus those undone.
 *
 * **Example** (A solve in twelve moves)
 *
 * ```ts
 * import { LevelSolved } from "@arcadekit/push-puzzle";
 * import { Schema } from "effect";
 *
 * const solved = new LevelSolved({ moves: 12 });
 * solved.moves; // => 12
 * Schema.is(LevelSolved)(solved); // => true
 * ```
 *
 * @category declarations
 */
export class LevelSolved extends Game.Event("LevelSolved", {
  moves: Schema.Int,
}) {}
