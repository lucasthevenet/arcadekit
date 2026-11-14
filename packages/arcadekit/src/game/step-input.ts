/**
 * Step inputs: where a loop's steps get their input, and how much one frame steps.
 *
 * A loop reads no device and no clock of its own: whoever runs a frame hands it an input source
 * and a budget. A device, a script and a lockstep session's buffer of confirmed inputs are each a
 * `StepInput`, so a test, a replay, the browser engine and a lockstep peer step a game the same
 * way. These are types a game writes as literals, so none has a `TypeId`.
 *
 * @since 0.7.0
 */

/**
 * Where each step's input comes from: a device, a script, or a buffer of confirmed inputs. A
 * loop calls `read` once per step, before the step, with the run's number of that step.
 *
 * **When to use**
 *
 * Whenever a loop runs a frame: a test or a replay writes one as a literal that reads a script,
 * and an engine's `input` returns one that reads a device (an `InputSource`).
 *
 * **Details**
 *
 * `read` runs inside the step loop, so returning the same object each time, refilled, keeps a
 * step free of allocation. A device source ignores the step's number; a script or a lockstep
 * buffer indexes by it, and may send the loop a command from `read`, which the loop applies in
 * that same step.
 *
 * `endStep` is called after every step: a source that reads presses forgets them there, so one
 * press reaches exactly one step even on a slow frame that runs several (`InputController`'s
 * `consumePresses`). `endFrame` is called once after a frame that ran a step, after its last
 * `endStep`, for what a source does once a frame, such as polling gamepads.
 *
 * **Example** (A script that reads by the step's number)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 *
 * const moves = [1, 0, -1];
 * const script: Game.StepInput<number> = { read: (step) => moves[step] ?? 0 };
 * script.read(0); // => 1
 * script.read(5); // => 0
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface StepInput<Input> {
  /**
   * Called once per step, before it. `step` is the run's number of the step about to run, from
   * 0 for the first step after `start`.
   */
  readonly read: (step: number) => Input;
  /** Called after every step: reset "just pressed" state here, so one press reaches one step. */
  readonly endStep?: () => void;
  /** Called once after each frame that ran a step, after its last `endStep`. */
  readonly endFrame?: () => void;
}

/**
 * A step input that owns what it reads with (listeners, devices), and gives it back in
 * `dispose`: what a `Game.Engine`'s `input` returns.
 *
 * **When to use**
 *
 * As the result of an engine's `input`, which the engine makes on each attach and disposes when
 * it detaches.
 *
 * **Details**
 *
 * `dispose` is plain: the engine calls it in the release of the `acquireRelease` it made the
 * source in, so a source has no lifecycle of its own (`InputController.make` and
 * `InputController.dispose` are the example).
 *
 * **Example** (A source that listens and lets go)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 *
 * const presses = new EventTarget();
 * let pressed = 0;
 * const onPress = () => {
 *   pressed += 1;
 * };
 * presses.addEventListener("press", onPress);
 * const source: Game.InputSource<number> = {
 *   read: () => pressed,
 *   dispose: () => presses.removeEventListener("press", onPress),
 * };
 * presses.dispatchEvent(new Event("press"));
 * source.read(0); // => 1
 * source.dispose();
 * presses.dispatchEvent(new Event("press"));
 * source.read(1); // => 1
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type InputSource<Input> = StepInput<Input> & {
  /** Gives back what the source reads with. */
  readonly dispose: () => void;
};

/**
 * How much one frame steps: `{ seconds }` of time passed, or exactly `{ steps }`.
 *
 * **When to use**
 *
 * As the second argument of a loop's `frame`: `{ seconds }` for frames timed by a clock, as an
 * attached engine's are, and `{ steps }` for a test, a replay or a lockstep session, which step
 * by count.
 *
 * **Details**
 *
 * With `{ seconds }`, the loop counts at most 0.25 s of one frame, turns it into whole steps on
 * the simulation's fixed clock, carries the rest to the next frame, and runs at most five steps:
 * a frame further behind drops its backlog, so a hidden tab or a debugger pause doesn't
 * fast-forward the game. With `{ steps }`, it runs exactly that many, with no clamp and no cap,
 * and forgets what `{ seconds }` frames had carried. A huge count blocks its thread.
 *
 * **Example** (A frame of time, and a frame of steps)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Count extends Game.Simulation("Count", {
 *   stepSeconds: 1 / 64,
 *   input: Schema.Null,
 *   create: () => ({ steps: 0 }),
 *   step: (count) => {
 *     count.steps += 1;
 *   },
 * }) {}
 *
 * const loop = Game.makeLoop(Count);
 * loop.start(null, 1, 0);
 * const none = { read: () => null };
 * loop.frame(none, { seconds: 3 / 64 }, 47); // => 3
 * loop.frame(none, { seconds: 1 }, 1047); // => 5
 * loop.frame(none, { steps: 100 }, 1047); // => 100
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type FrameBudget =
  | { readonly seconds: number }
  | { readonly steps: number };
