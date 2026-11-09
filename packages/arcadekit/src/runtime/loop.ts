import { FixedStepClock } from "../core/index";
import type { GameSimulation, StepInput } from "./simulation";

/** Longest frame gap counted, so a hidden tab or a debugger pause doesn't fast-forward the game. */
const MAX_FRAME_SECONDS = 0.25;

/**
 * How much one frame steps.
 *
 * - `{ seconds }`: time passed. The loop counts at most 0.25 s, turns it into whole steps on its
 *   fixed clock, carries the remainder, and drops the backlog after the clock's
 *   `maxStepsPerFrame` (5). The browser engine's frames (`makeGameEngine`) use it.
 * - `{ steps }`: exactly this many steps. No clamp, no cap, no drop, and it clears any remainder
 *   carried from `{ seconds }` frames. Tests, replays and lockstep use it. It has no cap, so a
 *   caller that passes a huge count blocks its thread.
 */
export type FrameBudget =
  | { readonly seconds: number }
  | { readonly steps: number };

/**
 * Runs a GameSimulation: one run at a time, its fixed clock, its events and samples. It owns the
 * step order and the time policy. Time and input come from the caller, so it needs no DOM and
 * reads no global clock.
 *
 * `frame` is the seam where stepping adapters plug in: the browser engine (`makeGameEngine`, one
 * frame per requestAnimationFrame callback), tests and replays (a scripted `StepInput` and
 * `{ steps }` frames), and a timer or lockstep runner.
 *
 * Listeners must not call `frame`, `start` or `modify` synchronously while an event is
 * delivered; schedule that work instead.
 */
export class GameLoop<Config, State, Input, Event> {
  private run: State | null = null;
  private steps = 0;
  private paused = false;
  private readonly clock: FixedStepClock;
  private readonly listeners = new Set<(event: Event) => void>();
  private lastSample = 0;
  private lastVersion = 0;
  private readonly simulation: GameSimulation<Config, State, Input, Event>;

  constructor(simulation: GameSimulation<Config, State, Input, Event>) {
    this.simulation = simulation;
    this.clock = new FixedStepClock(simulation.stepSeconds ?? 1 / 60);
  }

  /** The current run's state, or null between runs. Read it; change it only through `modify`. */
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

  /**
   * Changes the current state between steps (a menu choice, a cheat), then reports any events
   * that produced, and a sample if `version` moved. Does nothing with no run. A lockstep run
   * schedules its changes as step input instead (ADR-0012).
   */
  modify(change: (state: State) => void, nowMs: number): void {
    if (this.run === null) {
      return;
    }
    change(this.run);
    this.flushEvents(this.run);
    this.emitSampleIfChanged(this.run, nowMs);
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
