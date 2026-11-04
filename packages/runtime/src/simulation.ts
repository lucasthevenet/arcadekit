/**
 * The DOM-free half of a game: everything needed to step a run. It runs in a browser, a Web
 * Worker, on a server or in a test. A genre exports one from its root entry; `GameLoop` runs it.
 *
 * - `Config`: what starting a run needs (content, chosen character, difficulty…).
 * - `State`: the simulation state. The runtime never looks inside it.
 * - `Input`: one step's worth of player input, as the game wants it.
 * - `Event`: the facts the game reports to the outside (UI, sound, analytics).
 */
export interface GameSimulation<Config, State, Input, Event> {
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
   * - every `everyMs`, measured on the `nowMs` the loop's caller passes in (real time in the
   *   browser), for a state that changes all the time (a real-time game);
   * - and/or right after any frame or `modify` in which `version` changed, for a state that
   *   changes rarely (a turn-based game). `version` is a cheap number the game bumps whenever
   *   what `read` reports may have changed, such as a turn counter.
   */
  readonly sample?: {
    readonly everyMs?: number;
    readonly version?: (state: State) => number;
    readonly read: (state: State) => Event;
  };
}

/** Where each step's input comes from: a device, a script, or a buffer of confirmed inputs. */
export interface StepInput<Input> {
  /**
   * Called once per simulation step, before `step`. `step` is the run's index of the step about
   * to run (0 for the first step after `start`). A device source ignores it; a script or a
   * lockstep buffer indexes by it. It runs inside the step loop, so returning the same object
   * each time, refilled, keeps the loop free of allocation.
   */
  readonly read: (step: number) => Input;
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
}
