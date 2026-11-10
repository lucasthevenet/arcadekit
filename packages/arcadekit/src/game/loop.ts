import { Duration, Effect, Function } from "effect";

import { EventBuffer } from "../core/index";
import { GameLoop } from "../runtime/index";
import type { FrameBudget, GameSimulation, StepInput } from "../runtime/index";
import { CommandDropped } from "./command";
import type { AnyCommand, Settled } from "./command";
import { resolve } from "./simulation";
import type {
  CommandContext,
  RefusalFor,
  Resolved,
  SimulationClass,
  StepContext,
} from "./simulation";

// Plain code, like the step it runs (ADR-0017): no Effect, no clock of its own. Time comes in
// with each call.

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The tag of a `Game.Rejection` value, or undefined for anything else. */
const rejectionTag = (result: unknown): string | undefined => {
  const made = (result as { readonly constructor?: unknown } | null | undefined)
    ?.constructor as
    | { readonly kind?: unknown; readonly tag?: unknown }
    | undefined;
  return made?.kind === "Rejection" && typeof made.tag === "string"
    ? made.tag
    : undefined;
};

/** What a handler returned, in words, for the error that refuses it. */
const describeResult = (result: unknown): string => {
  // A rejection is also an Effect (it can be yielded to fail with), so it is told apart first.
  const rejection = rejectionTag(result);
  if (rejection !== undefined) {
    return `the rejection "${rejection}"`;
  }
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
 * Refuses what a handler returned. A `step` changes the state in place and returns nothing, and
 * so does an `apply` handler that takes its command. Their types say so, but a cast or plain
 * JavaScript gets past a type: an `async` step, a step that returns an Effect, a handler that
 * returns the next state or the events to report. The loop would drop each of them in silence,
 * so it throws instead.
 */
const refuseResult = (result: unknown, simulation: string, handler: string) => {
  if (result !== undefined) {
    throw new Error(
      `Simulation "${simulation}": ${handler} returned ${describeResult(result)}. A handler changes the state in place and returns nothing: it can't be async, the loop runs no Effect, and an event is reported with report(). An apply handler may also return one of the rejections its command declares.`
    );
  }
};

/** A command waiting for the next step. */
interface Pending<Command> {
  readonly command: Command;
  /** The slot of the player who sent it. */
  readonly player: number;
  /** Told once how the command ended, if the sender asked. */
  readonly settled: ((outcome: Settled<unknown>) => void) | undefined;
}

const tagOf = (command: unknown): string =>
  (command as { readonly _tag: string })._tag;

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
 * and how much it steps. Listeners, and the `settled` callback of a sent command, must not call
 * `frame`, `start`, `stop` or `send` while they are being called.
 *
 * When `frame` returns, its steps are over: a step is one plain call. The loop holds a game to
 * that by refusing a `step` or an `apply` handler that returns anything it shouldn't (a promise,
 * an Effect, the next state, a list of events), which a cast would otherwise let through and the
 * loop would drop.
 */
export class Loop<Config, State, Input, Event, Command, Refusals = unknown> {
  private readonly name: string;
  private readonly definition: Resolved<Config, State, Input, Event, Command>;
  private readonly commands: ReadonlyMap<string, AnyCommand>;
  private readonly loop: GameLoop<Config, State, Input, Event>;
  private readonly events = new EventBuffer<Event>();
  private pending: Pending<Command>[] = [];
  private readonly report = (event: Event): void => {
    this.events.push(event);
  };

  constructor(
    simulation: SimulationClass<
      string,
      Config,
      State,
      Input,
      Event,
      Command,
      Refusals
    >
  ) {
    this.name = simulation.simulationName;
    this.definition = resolve(simulation);
    this.commands = new Map(
      this.definition.commands.map((command) => [command.tag, command])
    );
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
   * Starts a new run, replacing any current one: drops the commands the run before hadn't
   * applied, makes the new state, unpauses, reports the events `create` produced, then the first
   * sample.
   */
  start(config: Config, seed: number, nowMs: number): void {
    this.drop("runEnded");
    this.loop.start(config, seed, nowMs);
  }

  /**
   * Sends a command to the current run. The rules get it at the start of the next step, after
   * the commands sent before it. `player` is the sender's slot: 0 unless several players share
   * the run.
   *
   * `settled` is called once with how it ended: `undefined` when its `apply` handler took it,
   * the rejection the handler refused it with, or a `CommandDropped` if it never reached the
   * rules. That is at once with no run, and otherwise when the run ends first (`stop`, a new
   * `start`, a frame that throws).
   *
   * Returns a function that takes the command back if it hasn't been applied yet. `settled` is
   * then never called.
   */
  send<C extends Command>(
    command: C,
    player = 0,
    settled?: (outcome: Settled<RefusalFor<Refusals, C>>) => void
  ): () => void {
    const tag = tagOf(command);
    if (!this.commands.has(tag)) {
      throw new Error(
        `Simulation "${this.name}" has no command "${tag}": list it in \`commands\` and handle it in \`apply\``
      );
    }
    if (this.loop.state === null) {
      settled?.(new CommandDropped({ command: tag, reason: "noRun" }));
      // Nothing is waiting, so there is nothing to take back.
      return Function.constVoid;
    }
    const sent: Pending<Command> = {
      command,
      player,
      settled: settled as Pending<Command>["settled"],
    };
    this.pending.push(sent);
    return () => {
      const at = this.pending.indexOf(sent);
      if (at !== -1) {
        this.pending.splice(at, 1);
      }
    };
  }

  /** While paused, frames run nothing and their time is discarded. Commands wait. */
  setPaused(paused: boolean): void {
    this.loop.setPaused(paused);
  }

  /** Ends the current run. Commands it hadn't applied are dropped, and their senders told. */
  stop(): void {
    this.loop.stop();
    this.drop("runEnded");
  }

  /** Calls `listener` for every event and sample, in order. Returns a function that stops it. */
  subscribe(listener: (event: Event) => void): () => void {
    return this.loop.subscribe(listener);
  }

  /**
   * Runs one frame. `budget` is `{ seconds }` of time passed (the browser's frames) or exactly
   * `{ steps }` (tests, replays, lockstep). Returns the number of steps run; 0 with no run, while
   * paused, or while a `{ seconds }` frame's time is still short of a step.
   *
   * A frame that throws (a bug in a step, or a handler that returns what it shouldn't) leaves
   * the run where the throw left it. The commands waiting then are dropped: whoever catches the
   * throw ends the run, as the engine does.
   */
  frame(input: StepInput<Input>, budget: FrameBudget, nowMs: number): number {
    try {
      return this.loop.frame(input, budget, nowMs);
    } catch (error) {
      this.drop("runEnded");
      throw error;
    }
  }

  /** The definition as the kernel loop steps it, with this loop's commands and events. */
  private compile(): GameSimulation<Config, State, Input, Event> {
    const { definition, report, events, name } = this;
    // One context for the run's steps and one for its commands, refilled in place.
    const stepContext: Mutable<StepContext<Event>> = {
      dt: 0,
      step: 0,
      report,
    };
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
        refuseResult(definition.step(state, input, stepContext), name, "step");
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

  /**
   * Gives each waiting command to its `apply` handler, in the order sent, and tells its sender
   * how it ended. A handler that throws, or returns what it shouldn't, stops the frame: the
   * commands after it go back to waiting, so `frame` drops them with the rest.
   */
  private applyPending(
    state: State,
    context: Mutable<CommandContext<Event>>
  ): void {
    const sent = this.pending;
    this.pending = [];
    for (let i = 0; i < sent.length; i++) {
      const { command, player, settled } = sent[i]!;
      const tag = tagOf(command);
      context.player = player;
      let result: unknown;
      try {
        result = this.definition.apply[tag]!(state, command, context);
        if (result !== undefined && !this.isRejectionOf(tag, result)) {
          const undeclared = rejectionTag(result);
          if (undeclared !== undefined) {
            throw new Error(
              `Simulation "${this.name}": apply.${tag} returned the rejection "${undeclared}", which the command "${tag}" doesn't declare. List it in the command's \`rejects\`.`
            );
          }
          refuseResult(result, this.name, `apply.${tag}`);
        }
      } catch (error) {
        // This one and those after it never reached the rules.
        this.pending = [...sent.slice(i), ...this.pending];
        throw error;
      }
      settled?.(result);
    }
  }

  /** Whether `result` is a value of one of the rejections the command `tag` declares. */
  private isRejectionOf(tag: string, result: unknown): boolean {
    return this.commands
      .get(tag)!
      .rejects.some(
        (rejection) =>
          result instanceof
          (rejection as unknown as new (...args: never[]) => object)
      );
  }

  /** Drops every waiting command and tells its sender. */
  private drop(reason: CommandDropped["reason"]): void {
    const dropped = this.pending;
    this.pending = [];
    for (const { command, settled } of dropped) {
      settled?.(new CommandDropped({ command: tagOf(command), reason }));
    }
  }
}
