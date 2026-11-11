import { FixedStepClock } from "../core/index";
import type { StepInput } from "./step-input";

/** Longest frame gap counted, so a hidden tab or a debugger pause doesn't fast-forward the game. */
const MAX_FRAME_SECONDS = 0.25;

/**
 * How much one frame steps.
 *
 * - `{ seconds }`: time passed. The loop counts at most 0.25 s, turns it into whole steps on its
 *   fixed clock, carries the remainder, and drops the backlog after the clock's
 *   `maxStepsPerFrame` (5). The browser engine's frames (`Game.Engine`) use it.
 * - `{ steps }`: exactly this many steps. No clamp, no cap, no drop, and it clears any remainder
 *   carried from `{ seconds }` frames. Tests, replays and lockstep use it. It has no cap, so a
 *   caller that passes a huge count blocks its thread.
 */
export type FrameBudget =
  | { readonly seconds: number }
  | { readonly steps: number };

/**
 * What the kernel steps: a run's `create`, `step`, events and sample as plain functions over a
 * state it never looks inside. No game writes one and no entry exports it: `Game.Loop` makes one
 * from a declared `Game.Simulation`, with the simulation's commands and its event buffer behind
 * `step` and `drainEvents`.
 *
 * - `Config`: what starting a run needs (content, chosen character, difficulty…).
 * - `State`: the simulation state.
 * - `Input`: one step's worth of player input, as the game wants it.
 * - `Event`: the facts the game reports to the outside (UI, sound, analytics).
 */
export interface KernelSimulation<Config, State, Input, Event> {
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
   * - and/or right after any frame in which `version` changed, for a state that changes rarely
   *   (a turn-based game). `version` is a cheap number the game bumps whenever what `read`
   *   reports may have changed, such as a turn counter.
   */
  readonly sample?: {
    readonly everyMs?: number;
    readonly version?: (state: State) => number;
    readonly read: (state: State) => Event;
  };
}

/**
 * The kernel under `Game.Loop` (loop.ts): it runs a `KernelSimulation`, one run at a time, on its
 * fixed clock, and delivers its events and samples. It owns the step order and the time policy.
 * Time and input come from the caller, so it needs no DOM and reads no global clock.
 *
 * No entry exports it. `Game.Loop` makes the `KernelSimulation` from a declared simulation, adds
 * its commands, and calls `frame` for every host, which are the browser engine (one frame per
 * requestAnimationFrame callback), tests and replays (a scripted `StepInput` and `{ steps }`
 * frames), and a lockstep session. Every recorded hash of a run was computed by the lines below
 * that step, so they change only with those hashes.
 *
 * Listeners must not call `frame` or `start` synchronously while an event is delivered; schedule
 * that work instead.
 */
export class Kernel<Config, State, Input, Event> {
  private run: State | null = null;
  private steps = 0;
  private paused = false;
  private readonly clock: FixedStepClock;
  private readonly listeners = new Set<(event: Event) => void>();
  private lastSample = 0;
  private lastVersion = 0;
  private readonly simulation: KernelSimulation<Config, State, Input, Event>;

  constructor(simulation: KernelSimulation<Config, State, Input, Event>) {
    this.simulation = simulation;
    this.clock = new FixedStepClock(simulation.stepSeconds ?? 1 / 60);
  }

  /** The current run's state, or null between runs. Read it; only a step changes it. */
  get state(): State | null {
    return this.run;
  }

  /** Steps run since `start`: the index of the next step. 0 with no run. */
  get stepIndex(): number {
    return this.steps;
  }

  /**
   * Starts a new run, replacing any current one: creates its state, unpauses, resets the clock,
   * reports the events creation produced, then the first sample.
   */
  start(config: Config, seed: number, nowMs: number): void {
    const state = this.simulation.create(config, seed);
    this.run = state;
    this.steps = 0;
    this.paused = false;
    this.clock.reset();
    this.flushEvents(state);
    if (this.simulation.sample) {
      this.emitSample(state, nowMs);
    }
  }

  /** While paused, frames run nothing and their budget is discarded: paused time doesn't count. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Ends the current run. */
  stop(): void {
    this.run = null;
    this.steps = 0;
  }

  subscribe(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Runs one frame. With a run active and not paused: for each step `budget` owes,
   * `input.read(stepIndex)`, then `step`, then `input.endStep`; then `input.endFrame` once if any
   * step ran; then the events; then a sample if `everyMs` has passed since the last one (on
   * `nowMs`), or else if `version` moved.
   *
   * Returns the number of steps run. For a `{ steps }` budget, 0 means none were consumed (no
   * run, or paused), so the caller keeps them queued. A `{ seconds }` frame may also return 0
   * while its time is carried on the clock.
   */
  frame(input: StepInput<Input>, budget: FrameBudget, nowMs: number): number {
    const state = this.run;
    if (state === null || this.paused) {
      return 0;
    }
    const runStep = (stepSeconds: number) => {
      this.simulation.step(state, input.read(this.steps), stepSeconds);
      this.steps += 1;
      input.endStep?.();
    };
    let ran = 0;
    if ("steps" in budget) {
      const { steps } = budget;
      this.clock.reset();
      for (; ran < steps; ran++) {
        runStep(this.clock.stepSeconds);
      }
    } else {
      ran = this.clock.advance(
        Math.min(budget.seconds, MAX_FRAME_SECONDS),
        runStep
      );
    }
    if (ran > 0) {
      input.endFrame?.();
    }
    this.flushEvents(state);
    const { sample } = this.simulation;
    if (
      sample?.everyMs !== undefined &&
      nowMs - this.lastSample >= sample.everyMs
    ) {
      this.emitSample(state, nowMs);
    } else {
      this.emitSampleIfChanged(state, nowMs);
    }
    return ran;
  }

  private emitSample(state: State, nowMs: number) {
    const sample = this.simulation.sample!;
    this.lastSample = nowMs;
    this.lastVersion = sample.version?.(state) ?? 0;
    this.emit(sample.read(state));
  }

  /** Emits a sample if the game's `version` moved since the last one. */
  private emitSampleIfChanged(state: State, nowMs: number) {
    const version = this.simulation.sample?.version;
    if (version && version(state) !== this.lastVersion) {
      this.emitSample(state, nowMs);
    }
  }

  private flushEvents(state: State) {
    for (const event of this.simulation.drainEvents(state)) {
      this.emit(event);
    }
  }

  private emit(event: Event) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
