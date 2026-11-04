/**
 * Everything the runtime needs to run a game. A genre package implements this once;
 * the runtime handles the frame loop, timing, events and lifecycle.
 *
 * - `Config`: what starting a run needs (content, chosen character, difficulty…).
 * - `State`: the simulation state. The runtime never looks inside it.
 * - `Input`: one step's worth of player input, as the game wants it.
 * - `Event`: the facts the game reports to the outside (UI, sound, analytics).
 */
export interface GameDefinition<Config, State, Input, Event> {
  /** Simulation step length in seconds. Defaults to 1/60. */
  readonly stepSeconds?: number;
  readonly create: (config: Config, seed: number) => State;
  /**
   * Advances the state by one step of `dt` seconds. Must be deterministic: the same state, input
   * and `dt` give the same result. Must not allocate. A turn-based genre may ignore `dt`
   * (push-puzzle does).
   */
  readonly step: (state: State, input: Input, dt: number) => void;
  /** Returns, and forgets, the events produced since the last call. */
  readonly drainEvents: (state: State) => readonly Event[];
  /**
   * Optional sample: a read of the state for the UI (a HUD, for example), emitted as an event
   * when a run starts and then while it is active:
   *
   * - every `everyMs` of real time, for a state that changes all the time (a real-time game);
   * - and/or right after any frame or `modify` in which `version` changed, for a state that
   *   changes rarely (a turn-based game). `version` is a cheap number the game bumps whenever
   *   what `read` reports may have changed, such as a turn counter.
   */
  readonly sample?: {
    readonly everyMs?: number;
    readonly version?: (state: State) => number;
    readonly read: (state: State) => Event;
  };
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
