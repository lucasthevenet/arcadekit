/**
 * What runs a game's code to its end, now. A tick, a stage between ticks, an
 * action's handler and a plugin's setup each start a fiber that has to have
 * ended by the time it is started, and that may leave no fiber of its own
 * running: one that outlived it would change the game later, at a moment no
 * replay repeats.
 */
import type { Exit, Fiber, Metric } from "effect";

import type { TickDispatcher } from "./TickScheduler";

/**
 * Runs a game's code to its end, and counts the fibers it starts. An app has
 * one, and puts its `metrics` in the context its systems and handlers run in.
 *
 * @category Models
 */
export class Runner {
  /** The system running now, or the last one that ran. The app sets it. */
  running = "";
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
