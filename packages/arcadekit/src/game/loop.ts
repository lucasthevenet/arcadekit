import { Duration } from "effect";

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
 */
export class Loop<Config, State, Input, Event, Command> {
  private readonly definition: Resolved<Config, State, Input, Event, Command>;
  private readonly loop: GameLoop<Config, State, Input, Event>;
  private readonly events = new EventBuffer<Event>();
  private pending: Pending<Command>[] = [];
  private readonly emit = (event: Event): void => {
    this.events.push(event);
  };

  constructor(
    simulation: SimulationClass<string, Config, State, Input, Event, Command>
  ) {
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
    const { definition, emit, events } = this;
    // One context for the run's steps and one for its commands, refilled in place.
    const stepContext: Mutable<StepContext<Event>> = { dt: 0, step: 0, emit };
    const commandContext: Mutable<CommandContext<Event>> = {
      player: 0,
      step: 0,
      emit,
    };
    const { sample } = definition;
    return {
      stepSeconds: definition.stepSeconds,
      create: (config, seed) => definition.create(config, { seed, emit }),
      step: (state, input, dt) => {
        const step = this.loop.stepIndex;
        if (this.pending.length > 0) {
          commandContext.step = step;
          this.applyPending(state, commandContext);
        }
        stepContext.dt = dt;
        stepContext.step = step;
        definition.step(state, input, stepContext);
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
      apply(state, command, context);
    }
  }
}
