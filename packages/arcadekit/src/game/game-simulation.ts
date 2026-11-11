/**
 * What the kernel loop (`GameLoop`, game-loop.ts) steps: a run's `create`, `step`, events and
 * sample as plain functions over a state it never looks inside. No game writes one and no entry
 * exports it: `Game.Loop` makes one from a declared `Game.Simulation`, with the simulation's
 * commands and its event buffer behind `step` and `drainEvents`.
 *
 * - `Config`: what starting a run needs (content, chosen character, difficulty…).
 * - `State`: the simulation state.
 * - `Input`: one step's worth of player input, as the game wants it.
 * - `Event`: the facts the game reports to the outside (UI, sound, analytics).
 */
export interface GameSimulation<Config, State, Input, Event> {
  /** Simulation step length in seconds. Defaults to 1/60. */
  readonly stepSeconds?: number;
  readonly create: (config: Config, seed: number) => State;
  /**
   * Advances the state by one step of `dt` seconds. Must be deterministic: the same state, input
   * and `dt` give the same result. Must not allocate per entity. A turn-based genre may ignore `dt`
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
