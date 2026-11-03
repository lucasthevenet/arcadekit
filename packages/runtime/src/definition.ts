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
  /** Advances the state by `dt` seconds. Should be deterministic: same state, input and dt give the same result. */
  readonly step: (state: State, input: Input, dt: number) => void;
  /** Returns, and forgets, the events produced since the last call. */
  readonly drainEvents: (state: State) => readonly Event[];
  /** Optional periodic snapshot (a HUD, for example), emitted as an event every `everyMs` while a run is active. */
  readonly sample?: {
    readonly everyMs: number;
    readonly read: (state: State) => Event;
  };
  /** Creates the input reader for a surface. Called once per attach. */
  readonly createInput: (surface: HTMLElement) => InputSource<Input>;
  /** Creates the renderer for a container. Called once per attach. */
  readonly createView: (container: HTMLElement) => GameView<State>;
}

export interface InputSource<Input> {
  /**
   * Called once per simulation step, before `step`. It runs inside the step loop, so returning
   * the same object each time, refilled, keeps the loop free of allocation.
   */
  readonly read: () => Input;
  /**
   * Called after each simulation step, to reset "just pressed" state, so each press reaches
   * exactly one step even when a slow frame runs several. Not called on frames that run no step,
   * so a press is never lost. (The name is older than this rule: it runs per step, not per frame.)
   */
  readonly endFrame?: () => void;
  readonly dispose: () => void;
}

export interface GameView<State> {
  /**
   * Draws one frame. `state` is null when no run is active (menus).
   * `alpha` (0-1) is how far real time is between the last step and the next, for interpolation.
   */
  readonly render: (
    state: State | null,
    timeSeconds: number,
    alpha: number
  ) => void;
  readonly dispose: () => void;
}
