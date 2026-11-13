import { Duration, Effect, Function } from "effect";

import { EventBuffer } from "../core/index";
import { CommandDropped } from "./command";
import type { AnyCommand, Settled } from "./command";
import { Kernel } from "./kernel";
import type { FrameBudget, KernelSimulation } from "./kernel";
import { resolve } from "./simulation";
import type {
  CommandContext,
  RefusalFor,
  Resolved,
  SimulationClass,
  StepContext,
} from "./simulation";
import type { StepInput } from "./step-input";

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

/** A command a sender handed to the loop. */
interface Sent<Command> {
  readonly command: Command;
  /** The slot of the player who sent it. */
  readonly player: number;
  /** Told once how the command ended, if the sender asked. */
  readonly settled: ((outcome: Settled<unknown>) => void) | undefined;
  /** Set when the sender takes the command back: it is then not applied, and not told. */
  withdrawn: boolean;
}

/** How a command ended, kept until its sender can be told. */
interface Answer<Command> {
  readonly sent: Sent<Command>;
  readonly outcome: Settled<unknown>;
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
 * The source's `read(step)` may call `send`: a command sent there is applied in that same step,
 * before `step`, after the commands that were already waiting. That is how a host that knows
 * which step a command belongs to gives it to the rules at exactly that step: a script that
 * replays a run, or a lockstep session, whose source reads a step every peer has agreed on.
 *
 * It needs no DOM and reads no clock: the caller passes the time, and decides when a frame runs
 * and how much it steps. A listener must not call `frame`, `start`, `stop` or `send` while it is
 * being called: it runs in the middle of one of them.
 *
 * A sender is told how its command ended once the loop is out of the call that ended it: after
 * the frame's steps, events and sample, or after `start` or `stop` has done its work. So a
 * `settled` callback may send, start or stop. A call that throws tells nobody: the answers it
 * owes are kept, and the next `stop`, `start` or `frame` that returns gives them.
 *
 * When `frame` returns, its steps are over: a step is one plain call. The loop holds a game to
 * that by refusing a `step` or an `apply` handler that returns anything it shouldn't (a promise,
 * an Effect, the next state, a list of events), which a cast would otherwise let through and the
 * loop would drop.
 */
export class Loop<Config, State, Input, Event, Command, Refusals> {
  private readonly name: string;
  private readonly definition: Resolved<Config, State, Input, Event, Command>;
  private readonly commands: ReadonlyMap<string, AnyCommand>;
  private readonly kernel: Kernel<Config, State, Input, Event>;
  private readonly events = EventBuffer.make<Event>();
  /** The commands waiting for the next step, in the order sent. */
  private pending: Sent<Command>[] = [];
  /** The answers owed to senders, in the order the commands ended. */
  private answers: Answer<Command>[] = [];
  /** How many events have been reported: it tells a handler that reported from one that didn't. */
  private reports = 0;
  private readonly report = (event: Event): void => {
    this.reports += 1;
    EventBuffer.push(this.events, event);
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
    this.kernel = new Kernel(this.compile());
  }

  /** The current run's state, or null between runs. Read it; change it only through a step. */
  get state(): State | null {
    return this.kernel.state;
  }

  /** Steps run since `start`: the number of the next step. 0 with no run. */
  get stepIndex(): number {
    return this.kernel.stepIndex;
  }

  /**
   * Starts a new run, replacing any current one: makes the new state, unpauses, reports the
   * events `create` produced, then the first sample, and then drops the commands the run before
   * hadn't applied and tells their senders.
   *
   * If `create` throws there is no new run: the run before goes on with its commands, and what
   * `create` had reported is discarded.
   */
  start(config: Config, seed: number, nowMs: number): void {
    // What a frame that threw left unreported is not the new run's to report.
    EventBuffer.drain(this.events);
    try {
      this.kernel.start(config, seed, nowMs);
    } catch (error) {
      EventBuffer.drain(this.events);
      throw error;
    }
    this.drop("runEnded");
    this.tell();
  }

  /**
   * Sends a command to the current run. The rules get it at the start of the next step, after
   * the commands sent before it: sent from the input source's `read(step)`, that is the step
   * being read. `player` is the sender's slot: 0 unless several players share the run.
   *
   * `settled` is called once with how it ended: `undefined` when its `apply` handler took it,
   * the rejection the handler refused it with, or a `CommandDropped` if the rules gave no
   * answer. That is at once with no run, and otherwise when the run ends first (`stop`, a new
   * `start`) or its handler threw. It is called once the loop is out of the call that ended the
   * command, never between two handlers, so it may send, start or stop.
   *
   * Returns a function that takes the command back: if it hasn't been applied yet it never is,
   * and `settled` is not called after it.
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
    if (this.kernel.state === null) {
      settled?.(new CommandDropped({ command: tag, reason: "noRun" }));
      // Nothing is waiting, so there is nothing to take back.
      return Function.constVoid;
    }
    const sent: Sent<Command> = {
      command,
      player,
      settled: settled as Sent<Command>["settled"],
      withdrawn: false,
    };
    this.pending.push(sent);
    return () => {
      sent.withdrawn = true;
      const at = this.pending.indexOf(sent);
      if (at !== -1) {
        this.pending.splice(at, 1);
      }
    };
  }

  /** While paused, frames run nothing and their time is discarded. Commands wait. */
  setPaused(paused: boolean): void {
    this.kernel.setPaused(paused);
  }

  /**
   * Ends the current run. Commands it hadn't applied are dropped, and their senders told. What a
   * frame that threw had left unreported is discarded.
   */
  stop(): void {
    this.kernel.stop();
    EventBuffer.drain(this.events);
    this.drop("runEnded");
    this.tell();
  }

  /**
   * Calls `listener` for every event and sample, in order, inside the `start` or the `frame`
   * that reports it: so before the sender of a command that call answered is told. Returns a
   * function that stops it.
   */
  subscribe(listener: (event: Event) => void): () => void {
    return this.kernel.subscribe(listener);
  }

  /**
   * Runs one frame. `budget` is `{ seconds }` of time passed (the browser's frames) or exactly
   * `{ steps }` (tests, replays, lockstep). Returns the number of steps run; 0 with no run, while
   * paused, or while a `{ seconds }` frame's time is still short of a step.
   *
   * A frame that throws (a bug in a step, or a handler that returns what it shouldn't) leaves
   * the run where the throw left it, and tells nobody. Whoever catches the throw ends the run
   * with `stop`, as the engine does, and the senders hear then. A command whose handler threw is
   * told it was dropped, though the handler may have changed the state first; those sent after
   * it still wait. One the frame had applied before the throw is told the rules' answer, the
   * one case where a sender hears of a step no listener heard: `stop` discards what that frame
   * reported.
   */
  frame(input: StepInput<Input>, budget: FrameBudget, nowMs: number): number {
    const steps = this.kernel.frame(input, budget, nowMs);
    if (this.answers.length > 0) {
      this.tell();
    }
    return steps;
  }

  /** The definition as the kernel steps it, with this loop's commands and events. */
  private compile(): KernelSimulation<Config, State, Input, Event> {
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
        const step = this.kernel.stepIndex;
        if (this.pending.length > 0) {
          commandContext.step = step;
          this.applyPending(state, commandContext);
        }
        stepContext.dt = dt;
        stepContext.step = step;
        refuseResult(definition.step(state, input, stepContext), name, "step");
      },
      drainEvents: () => EventBuffer.drain(events),
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
   * Gives each waiting command to its `apply` handler, in the order sent, and keeps how it ended
   * for its sender. A handler that throws, or returns what it shouldn't, stops the frame: its
   * command is dropped, and the commands after it go back to waiting.
   */
  private applyPending(
    state: State,
    context: Mutable<CommandContext<Event>>
  ): void {
    const batch = this.pending;
    this.pending = [];
    for (let i = 0; i < batch.length; i++) {
      const sent = batch[i]!;
      const tag = tagOf(sent.command);
      context.player = sent.player;
      const reported = this.reports;
      let result: unknown;
      try {
        result = this.definition.apply[tag]!(state, sent.command, context);
        if (result !== undefined) {
          this.checkRefusal(tag, result, this.reports !== reported);
        }
      } catch (error) {
        this.answer(
          sent,
          new CommandDropped({ command: tag, reason: "runEnded" })
        );
        this.pending = [...batch.slice(i + 1), ...this.pending];
        throw error;
      }
      this.answer(sent, result);
    }
  }

  /**
   * Throws unless what an `apply` handler returned is a refusal it may make: a value of one of
   * the rejections its command declares, from a handler that reported nothing.
   */
  private checkRefusal(tag: string, result: unknown, reported: boolean): void {
    if (!this.isRejectionOf(tag, result)) {
      const returned = rejectionTag(result);
      if (returned === undefined) {
        refuseResult(result, this.name, `apply.${tag}`);
      }
      const declared = this.commands
        .get(tag)!
        .rejects.some((rejection) => rejection.tag === returned);
      throw new Error(
        declared
          ? `Simulation "${this.name}": apply.${tag} returned a rejection "${returned}" made by another class than the one the command "${tag}" declares under that tag. Return a value of the class in the command's \`rejects\`.`
          : `Simulation "${this.name}": apply.${tag} returned the rejection "${returned}", which the command "${tag}" doesn't declare. List it in the command's \`rejects\`.`
      );
    }
    if (reported) {
      throw new Error(
        `Simulation "${this.name}": apply.${tag} reported an event and then refused its command. A handler decides before it changes anything: a refused command changed nothing in the run, so it has nothing to report.`
      );
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

  /** Drops every waiting command, to be told with the reason. */
  private drop(reason: CommandDropped["reason"]): void {
    const dropped = this.pending;
    if (dropped.length === 0) {
      return;
    }
    this.pending = [];
    for (const sent of dropped) {
      this.answer(
        sent,
        new CommandDropped({ command: tagOf(sent.command), reason })
      );
    }
  }

  /** Keeps how a command ended, for a sender that asked. */
  private answer(sent: Sent<Command>, outcome: Settled<unknown>): void {
    if (sent.settled !== undefined) {
      this.answers.push({ sent, outcome });
    }
  }

  /**
   * Tells each sender how its command ended, in the order they ended. The loop is out of its
   * own work by now, so a sender may send, start or stop from here. One that throws doesn't keep
   * the others from hearing: the first throw is rethrown once all were told.
   */
  private tell(): void {
    const { answers } = this;
    if (answers.length === 0) {
      return;
    }
    this.answers = [];
    let thrown: { readonly error: unknown } | undefined;
    for (const { sent, outcome } of answers) {
      if (!sent.withdrawn) {
        try {
          sent.settled?.(outcome);
        } catch (error) {
          thrown ??= { error };
        }
      }
    }
    if (thrown !== undefined) {
      throw thrown.error;
    }
  }
}
