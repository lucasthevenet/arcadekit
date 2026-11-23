/**
 * An Effect scheduler that runs queued work only when the game loop asks.
 *
 * Effect's default scheduler does two things a game tick can't allow:
 *
 * 1. It pauses a fiber after 2048 operations and resumes it later from
 *    `setImmediate` or a timer, so a heavy tick could be split across frames.
 * 2. It decides on its own when queued fibers resume.
 *
 * This scheduler never yields on its own, and runs queued work only when the
 * game loop calls `dispatcher.flush()`. Fibers therefore resume at one known
 * point in every tick, in a deterministic order.
 */
import type * as Scheduler from "effect/Scheduler";

/**
 * Holds the work that fibers have queued, in order, until the tick flushes it.
 *
 * @category Models
 */
export class TickDispatcher implements Scheduler.SchedulerDispatcher {
  private buckets: [priority: number, tasks: Array<() => void>][] = [];
  private flushing = false;

  /**
   * The most rounds a flush runs before it throws. A fiber that keeps
   * rescheduling itself, such as `Effect.forever(Effect.yieldNow)`, would
   * otherwise hang the tick.
   */
  maxRounds = 10_000;

  /** How many tasks are queued. */
  get pending(): number {
    let total = 0;
    for (const bucket of this.buckets) {
      total += bucket[1].length;
    }
    return total;
  }

  /**
   * Queues a task. Lower priority numbers run first, as in Effect's own
   * scheduler.
   */
  scheduleTask(task: () => void, priority: number): void {
    const { buckets } = this;
    let index = 0;
    for (const bucket of buckets) {
      if (bucket[0] === priority) {
        bucket[1].push(task);
        return;
      }
      if (bucket[0] > priority) {
        break;
      }
      index += 1;
    }
    buckets.splice(index, 0, [priority, [task]]);
  }

  /**
   * Runs queued tasks, including any they queue, until nothing is left. It
   * throws after `maxRounds` rounds.
   */
  flush(): void {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      let rounds = 0;
      while (this.buckets.length > 0) {
        rounds += 1;
        if (rounds > this.maxRounds) {
          this.buckets = [];
          throw new Error(
            `TickDispatcher: still busy after ${this.maxRounds} rounds in one tick. ` +
              `A fiber is probably looping on Effect.yieldNow; keep the work in a component or a state that a system moves on each tick instead.`
          );
        }
        const { buckets } = this;
        this.buckets = [];
        for (const bucket of buckets) {
          for (const task of bucket[1]) {
            task();
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

/**
 * The scheduler an app runs its fibers on. It never pauses a fiber on its own,
 * and runs queued work only when the tick flushes its dispatcher.
 *
 * @category Models
 */
export class TickScheduler implements Scheduler.Scheduler {
  readonly executionMode = "sync" as const;
  readonly dispatcher: TickDispatcher;

  constructor(dispatcher: TickDispatcher = new TickDispatcher()) {
    this.dispatcher = dispatcher;
  }

  /** Returns false, so a fiber is never paused in the middle of a tick. */
  shouldYield(): boolean {
    return false;
  }

  /**
   * Returns the one dispatcher that every fiber shares, so one flush runs all
   * their work.
   */
  makeDispatcher(): TickDispatcher {
    return this.dispatcher;
  }
}
