import type { GameSimulation } from "./simulation";

/**
 * Everything the runtime needs to run a game in the browser: its simulation, plus how it reads
 * input from the viewport and draws into it.
 */
export interface GameDefinition<
  Config,
  State,
  Input,
  Event,
> extends GameSimulation<Config, State, Input, Event> {
  /** Creates the input source (`InputSource`) that reads input from the viewport element. Called once per attach. */
  readonly createInput: (surface: HTMLElement) => InputSource<Input>;
  /** Creates the view (`GameView`) that draws into the viewport element. Called once per attach. */
  readonly createView: (container: HTMLElement) => GameView<State>;
}

export interface InputSource<Input> {
  /**
   * Called once per simulation step, before `step`. It runs inside the step loop, so returning
   * the same object each time, refilled, keeps the loop free of allocation.
   */
  readonly read: () => Input;
  /**
   * Called after every step. Reset "just pressed" state here, so one press reaches exactly
   * one step even on a slow frame that runs several catch-up steps (a press that makes one
   * turn, a jump). `InputController.consumePresses` does this.
   */
  readonly endStep?: () => void;
  /**
   * Called once after each frame that ran at least one step, after its last `endStep`.
   * For per-frame work, like `InputController.endFrame`, which polls gamepads. A source that
   * resets presses here instead of in `endStep` lets one press reach every step of a frame:
   * fine for a game that reads only held state and axes.
   */
  readonly endFrame?: () => void;
  readonly dispose: () => void;
}

/**
 * Draws a game. Two rules apply to every view:
 *
 * - `render` reads the state and never changes it.
 * - Each run has its own state object: `start` calls `create` for every run. `render` gets that
 *   same object every frame until `stop` or the next `start`, so a view can tell runs apart by
 *   identity. Push-puzzle's view resets when the object changes, and survivors' view keys its
 *   color cache on it.
 */
export interface GameView<State> {
  /** Draws one frame. `state` is null when no run is active (menus). */
  readonly render: (state: State | null, timeSeconds: number) => void;
  readonly dispose: () => void;
}
