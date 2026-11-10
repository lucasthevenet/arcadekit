import { Duration, Effect } from "effect";

import { EventBuffer } from "../core/index";
import { GameLoop } from "../runtime/index";
import type { FrameBudget, GameSimulation, StepInput } from "../runtime/index";
import { resolve } from "./simulation";
import type {
  CommandContext,
  Resolved,
  SimulationClass,
  StepContext,
} from "./simulation";

// Plain code, like the step it runs (ADR-0017): no Effect, no clock of its own. Time comes in
// with each call.

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** What a handler returned, in words, for the error that refuses it. */
const describeResult = (result: unknown): string => {
  if (Effect.isEffect(result)) {
    return "an Effect";
  }
  if (
    typeof result === "object" &&
    result !== null &&
    typeof (result as { readonly then?: unknown }).then === "function"
  ) {
    return "a promise";
  }
  return Array.isArray(result) ? "an array" : "a value";
};

/**
 * Refuses what a `step` or an `apply` handler returned. A handler changes the state in place and
 * returns nothing, and its type (`=> void`) can't say so: an `async` step, a step that returns
 * an Effect, and a handler that returns the next state or the events to report all compile. The
 * loop would drop each of them in silence, so it throws instead.
 */
const refuseResult = (result: unknown, simulation: string, handler: string) => {
  if (result !== undefined) {
    throw new Error(
      `Simulation "${simulation}": ${handler} returned ${describeResult(result)}. A handler changes the state in place and returns nothing: it can't be async, the loop runs no Effect, and an event is reported with report().`
    );
  }
};

/** A command waiting for the next step, with the slot of the player who sent it. */
interface Pending<Command> {
  readonly command: Command;
  readonly player: number;
}

/**
 * Steps a `Game.Simulation`: one run at a time, its fixed clock, its commands, its events and
 * its samples. It owns the step order, so a test, a replay, the browser engine and a lockstep
 * peer all run a game the same way:
 *
 * - for each step a frame owes: the input source's `read`, then the commands sent since the last
 *   step, in order, then `step`, then the source's `endStep`;
 * - then the source's `endFrame`, once, if any step ran;
 * - then the events those steps reported;
 * - then a sample, if one is due.
 *
 * It needs no DOM and reads no clock: the caller passes the time, and decides when a frame runs
 * and how much it steps. Listeners must not call `frame`, `start` or `send` while an event is
 * delivered.
 *
 * When `frame` returns, its steps are over: a step is one plain call. The loop holds a game to
 * that by refusing a `step` or an `apply` handler that returns anything (a promise, an Effect,
 * the next state, a list of events), which would otherwise compile and be dropped.
 */
export class Loop<Config, State, Input, Event, Command> {
  private readonly name: string;
  private readonly definition: Resolved<Config, State, Input, Event, Command>;
  private readonly loop: GameLoop<Config, State, Input, Event>;
  private readonly events = new EventBuffer<Event>();
  private pending: Pending<Command>[] = [];
  private readonly report = (event: Event): void => {
    this.events.push(event);
  };

  constructor(
    simulation: SimulationClass<string, Config, State, Input, Event, Command>
  ) {
    this.name = simulation.simulationName;
    this.definition = resolve(simulation);
    this.loop = new GameLoop(this.compile());
  }

  /** The current run's state, or null between runs. Read it; change it only through a step. */
  get state(): State | null {
    return this.loop.state;
  }

  /** Steps run since `start`: the number of the next step. 0 with no run. */
  get stepIndex(): number {
    return this.loop.stepIndex;
  }

  /**
   * Starts a new run, replacing any current one: makes its state, unpauses, forgets the commands
   * of the run before, reports the events `create` produced, then the first sample.
   */
  start(config: Config, seed: number, nowMs: number): void {
    this.pending = [];
    this.loop.start(config, seed, nowMs);
  }

  /**
   * Sends a command to the current run. It is applied at the start of the next step, after the
   * commands sent before it. Does nothing with no run. `player` is the sender's slot: 0 unless
   * several players share the run.
   */
  send(command: Command, player = 0): void {
    if (this.loop.state !== null) {
      this.pending.push({ command, player });
    }
  }

  /** While paused, frames run nothing and their time is discarded. Commands wait. */
  setPaused(paused: boolean): void {
    this.loop.setPaused(paused);
  }

  /** Ends the current run. Commands it hadn't applied are dropped. */
  stop(): void {
    this.pending = [];
    this.loop.stop();
  }

  /** Calls `listener` for every event and sample, in order. Returns a function that stops it. */
  subscribe(listener: (event: Event) => void): () => void {
    return this.loop.subscribe(listener);
  }

  /**
   * Runs one frame. `budget` is `{ seconds }` of time passed (the browser's frames) or exactly
   * `{ steps }` (tests, replays, lockstep). Returns the number of steps run; 0 with no run, while
   * paused, or while a `{ seconds }` frame's time is still short of a step.
   */
  frame(input: StepInput<Input>, budget: FrameBudget, nowMs: number): number {
    return this.loop.frame(input, budget, nowMs);
  }

  /** The definition as the kernel loop steps it, with this loop's commands and events. */
  private compile(): GameSimulation<Config, State, Input, Event> {
    const { definition, report, events, name } = this;
    // One context for the run's steps and one for its commands, refilled in place.
    const stepContext: Mutable<StepContext<Event>> = { dt: 0, step: 0, report };
    const commandContext: Mutable<CommandContext<Event>> = {
      player: 0,
      step: 0,
      report,
    };
    const { sample } = definition;
    return {
      stepSeconds: definition.stepSeconds,
      create: (config, seed) => {
        const state = definition.create(config, { seed, report });
        const made = describeResult(state);
        if (made === "an Effect" || made === "a promise") {
          throw new Error(
            `Simulation "${name}": create returned ${made}. It makes the run's state and returns it in the same call: load what it needs before the run starts, and pass it in the config.`
          );
        }
        return state;
      },
      step: (state, input, dt) => {
        const step = this.loop.stepIndex;
        if (this.pending.length > 0) {
          commandContext.step = step;
          this.applyPending(state, commandContext);
        }
        stepContext.dt = dt;
        stepContext.step = step;
        const result: unknown = definition.step(state, input, stepContext);
        refuseResult(result, name, "step");
      },
      drainEvents: () => events.drain(),
      ...(sample === undefined
        ? {}
        : {
            sample: {
              ...(sample.every === undefined
                ? {}
                : { everyMs: Duration.toMillis(sample.every) }),
              ...(sample.version === undefined
                ? {}
                : { version: sample.version }),
              read: (state: State) => sample.make(sample.read(state)),
            },
          }),
    };
  }

  private applyPending(
    state: State,
    context: Mutable<CommandContext<Event>>
  ): void {
    const sent = this.pending;
    this.pending = [];
    for (const { command, player } of sent) {
      const { _tag } = command as { readonly _tag: string };
      const apply = this.definition.apply[_tag];
      if (apply === undefined) {
        throw new Error(`No apply.${_tag}: the simulation doesn't declare it`);
      }
      context.player = player;
      const result: unknown = apply(state, command, context);
      refuseResult(result, this.name, `apply.${_tag}`);
    }
  }
}
