/**
 * What runs a game's code to its end, now, and knows what is running. A tick,
 * a stage between ticks, an action's handler and a plugin's setup each start
 * a fiber that has to have ended by the time it is started, and that may
 * leave no fiber of its own running: one that outlived it would change the
 * game later, at a moment no replay repeats.
 */
import type { Exit, Fiber, Metric } from "effect";

import type { Phase } from "./App";
import type { TickDispatcher } from "./TickScheduler";

/**
 * Runs a game's code to its end, counts the fibers it starts, and says what
 * is running. An app has one, and puts its `metrics` in the context its
 * systems and handlers run in.
 *
 * @category Models
 */
export class Runner {
  /** The system running now, or the last one that ran. The app sets it. */
  running = "";
  /** Whether a tick is running. The app sets it. */
  ticking = false;
  /** The stage running between two ticks, if one is. The app sets it. */
  between: "frame" | "input" | undefined;
  /** The action whose handler is running, if one is. */
  applying: string | undefined;
  // How deep the app is in the game's own code between ticks: a plugin's
  // setup.
  private own = 0;
  /**
   * Counts every fiber started with the app's services when it starts and
   * when it ends, and passes both on to the metrics the app was given. While
   * a stage runs, the systems that start fibers are noted, for the message.
   */
  readonly metrics: Metric.FiberRuntimeMetricsService;
  private fibers = 0;
  private noting = false;
  private starters: Set<string> | undefined;
  private readonly dispatcher: TickDispatcher;
  private readonly done: () => void;

  /** `done` is called each time the game's code has been started and has returned. */
  constructor(
    dispatcher: TickDispatcher,
    outer: Metric.FiberRuntimeMetricsService | undefined,
    done: () => void
  ) {
    this.dispatcher = dispatcher;
    this.done = done;
    this.metrics = {
      recordFiberStart: (started) => {
        this.fibers++;
        if (this.noting && this.running !== "") {
          (this.starters ??= new Set()).add(this.running);
        }
        outer?.recordFiberStart(started);
      },
      recordFiberEnd: (ended, exit) => {
        this.fibers--;
        outer?.recordFiberEnd(ended, exit);
      },
    };
  }

  /** How much work fibers have queued for the next flush. */
  get pending(): number {
    return this.dispatcher.pending;
  }

  /**
   * What the app is running: `app.phase`. A handler a tick runs is part of
   * the tick: the stage wins.
   */
  get phase(): Phase {
    return this.ticking
      ? "tick"
      : (this.between ?? (this.applying === undefined ? "idle" : "handler"));
  }

  /**
   * Whether the code running now is the simulation's: a tick, an action's
   * handler, or a plugin's setup. What it issues isn't logged, since a
   * replay runs it again and issues it again. Anything else is input from
   * outside.
   */
  get simulating(): boolean {
    return this.ticking || this.applying !== undefined || this.own > 0;
  }

  /** Runs the game's own code between ticks, as the simulation's: a setup. */
  asOwn<A>(run: () => A): A {
    this.own++;
    try {
      return run();
    } finally {
      this.own--;
    }
  }

  /**
   * Refuses a call that is for between ticks while the app is running
   * something. `said` makes the message, given what it is running.
   */
  whileIdle(said: (busy: string) => string): void {
    const now = this.phase;
    if (now !== "idle") {
      throw new Error(
        said(
          now === "input"
            ? "run of the input stage"
            : now === "handler"
              ? `handler of "${this.applying}"`
              : now
        )
      );
    }
  }

  /**
   * The error to throw when more fibers are running than `before`, once what
   * the dispatcher holds has run: `what` started a fiber and left it
   * running. The systems noted as starting fibers are forgotten.
   */
  private left(before: number, what: string): Error | undefined {
    this.dispatcher.flush();
    const left = this.fibers - before;
    const noted = this.starters;
    this.noting = false;
    this.starters = undefined;
    if (left > 0) {
      const starters =
        noted === undefined
          ? ""
          : ` (started while ${[...noted].map((name) => `"${name}"`).join(", ")} ran)`;
      return new Error(
        `${what} left ${left === 1 ? "a fiber" : `${left} fibers`} running${starters}, with Effect.forkDetach, Effect.forkIn or another fork that outlives it. ` +
          `It would change the game later, at a moment no replay repeats. Wait for a fiber within the code that started it, ` +
          `or keep work that takes longer than a tick in the world, in a component or a state that a system moves on each tick.`
      );
    }
    return undefined;
  }

  /**
   * Runs the game's code to its end, now: `fork` starts it, and it has to
   * have ended by the time `fork` returns. Throws when it has not, with what
   * `waited` says, and when it left a fiber running, as `what` did. With
   * `noting`, the systems that start fibers while it runs are noted, for
   * that message.
   */
  finish<A, E>(
    fork: () => Fiber.Fiber<A, E>,
    what: string,
    waited: () => string,
    noting: boolean
  ): Exit.Exit<A, E> {
    const before = this.fibers;
    this.noting = noting;
    this.starters = undefined;
    let fiber: Fiber.Fiber<A, E>;
    try {
      fiber = fork();
    } finally {
      this.done();
    }
    const exit = fiber.pollUnsafe();
    if (exit === undefined) {
      fiber.interruptUnsafe();
      this.dispatcher.flush();
      throw new Error(waited());
    }
    const left = this.left(before, what);
    if (left !== undefined) {
      throw left;
    }
    return exit;
  }
}
