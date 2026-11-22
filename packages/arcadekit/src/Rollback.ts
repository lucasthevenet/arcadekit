/**
 * Rollback sessions: multiplayer games that don't wait for the network.
 *
 * A lockstep session runs a tick only once every peer has sent its actions for
 * it, so players see their own moves a few ticks late, and a slow network slows
 * everyone down. A rollback session runs each tick immediately, predicting that
 * the peers it hasn't heard from did nothing, which is true of most ticks. When
 * a message arrives for a tick that already ran, and it contains actions, the
 * session rewinds to before that tick and resimulates with what it now knows.
 *
 *   const app = yield* App.make({ plugins: [Game], seed })
 *   const session = Rollback.make(app, {
 *     peer: "ada",
 *     peers: ["ada", "grace"],
 *     delta: 1 / 60,
 *   })
 *
 *   app.enqueue(Move, { player: "ada", dx: 1 })
 *   session.tick()        // the move is in the world, whatever the network
 *
 * It is the same session as lockstep, with the same messages: a lockstep
 * session is a rollback session whose `ahead` is 0, so it predicts no ticks.
 * Everything `Lockstep` documents therefore applies here: the session takes
 * over its app, receives the messages that arrived and returns the ones to
 * send, is stepped by a driver, and stops with `Lockstep.Drifted` when the
 * peers drift apart.
 *
 * Every peer ends on the same game: each applies every action on the tick it is
 * stamped with, whenever it heard of it. Along the way, a peer may see a move
 * accepted that is later refused, once the message it was missing arrives.
 *
 * Rewinding goes back to a moment `Timeline.capture` took before each
 * uncertain tick, with the rewind that runs the same ticks again, so that the
 * frame and input stages hear an event once however often its tick is run. A
 * rewind restores only what a save holds: see `Timeline.rewind`.
 * A tick that reads anything else runs differently when it is resimulated,
 * and the peers drift apart. `Rollback.syncTest` finds such a tick in a test,
 * with no second peer.
 */
import { Cause, Data, Exit } from "effect";

import type * as App from "./App";
import type * as Lockstep from "./Lockstep";
import { build } from "./Lockstep";
import type * as Save from "./Save";
import * as Timeline from "./Timeline";

/**
 * Options for a rollback session: this peer, every peer, and how far it may run
 * ahead of what it has heard.
 *
 * @category Options
 */
export interface Options {
  /** This peer's name. */
  readonly peer: string;
  /**
   * Every peer of the game, including this one. Every peer is given the same
   * names, in any order.
   */
  readonly peers: readonly string[];
  /** The seconds a tick simulates, the same on every peer. */
  readonly delta: number;
  /**
   * How many ticks pass between issuing an action and applying it. Defaults to
   * 0, so a player's own move is applied on the very next tick. A delay of a
   * tick or two spares the other peers a rewind for every move, at the cost of
   * that much input lag for the local player.
   */
  readonly delay?: number;
  /**
   * How many ticks the session may run past what every peer has sent. Defaults
   * to 8. A peer that far ahead waits, as a lockstep session does. It is also
   * the furthest a rewind may go back, and the most moments kept for it.
   */
  readonly ahead?: number;
}

/**
 * One peer of a multiplayer game, which predicts. It extends a lockstep
 * session: `tickExit` can also fail with `Save.SaveRefused` when the game can't
 * be captured before an uncertain tick, in which case the tick doesn't run.
 *
 * @param E what a tick of its app can fail with
 *
 * @category Models
 */
export interface Session<E = never> extends Lockstep.Session<
  E | Save.SaveRefused
> {
  /** How many ticks the session may run past what every peer has sent. */
  readonly ahead: number;
  /**
   * The number of final ticks: every peer's messages for them have arrived, and
   * the game has run with them. Later ticks are predictions, and may be
   * resimulated differently.
   */
  readonly confirmed: number;
  /** How many times the session has rewound. */
  readonly rewinds: number;
  /** How many ticks the session has resimulated in total. */
  readonly resimulated: number;
  /**
   * How many moments the session holds to rewind to: one for each uncertain
   * tick it ran, so never more than `ahead`. Each is a snapshot of the whole
   * world. A tick every peer has already sent actions for isn't captured.
   */
  readonly kept: number;
}

/**
 * Makes a rollback session for an app, as `Lockstep.make` does, but one that
 * runs ahead of the network and rewinds when a prediction was wrong.
 *
 * @category Constructors
 */
export const make = <E>(
  app: Lockstep.SessionApp<E>,
  options: Options
): Session<E> =>
  build(app, {
    ...options,
    delay: options.delay ?? 0,
    ahead: options.ahead ?? 8,
  });

/**
 * A tick did not run the same twice from the same moment, as found by
 * `Rollback.syncTest`. It is a defect: the tick read something a rewind doesn't
 * put back, so a rollback session would resimulate it differently from how its
 * peers ran it.
 *
 * @category Errors
 */
export class RewindDiverged extends Data.TaggedError("RewindDiverged")<{
  /** The tick that ran differently. */
  readonly tick: number;
  /**
   * The system after which the world's hash first differed. Undefined when it
   * differed before the first system ran: in the handler of an action queued
   * for the tick, or in a hook of a state.
   */
  readonly system: string | undefined;
}> {
  override get message(): string {
    const where =
      this.system === undefined
        ? "before its first system ran, in the handler of an action queued for it or in a hook of a state"
        : `after system "${this.system}" ran`;
    return `Tick ${this.tick} ran differently the second time from the same moment: the world's hash was not the same ${where}. It read something a rewind doesn't put back, so a rollback session would run it again differently from its peers. Look for state kept outside the world, in a service, a plugin's own variable or a module, or for a value from outside the game, such as Date.now() or Math.random(). Keep it in the world: in a component, a singleton or a state.`;
  }
}

/**
 * What a sync test needs from its app. Every app provides it.
 *
 * @category Type-level
 */
export type SyncTestApp<E> = Pick<
  App.App<E>,
  "divert" | "frame" | "inputExit"
> &
  Timeline.Game;

/**
 * An app taken over by `Rollback.syncTest`, stepped in its place, by hand or by
 * a driver.
 *
 * @param E what a tick of its app can fail with
 *
 * @category Models
 */
export interface SyncTest<E = never> {
  /**
   * Runs the input stage, then the tick twice from the same moment, and fails
   * with `Save.SaveRefused` when the game can't be captured before it, in which
   * case the tick doesn't run. Throws `RewindDiverged` when the two runs differ.
   */
  readonly tickExit: (delta: number) => Exit.Exit<void, E | Save.SaveRefused>;
  /** Like `tickExit`, but throws what it fails with. */
  readonly tick: (delta: number) => void;
  /** The app's frame stage. */
  readonly frame: (alpha: number, delta?: number) => void;
  /** How many ticks it has run twice. */
  readonly checked: number;
}

/**
 * Takes over an app to check that each of its ticks runs the same when a
 * rewind runs it again, as a rollback session does. Each tick is run, rewound
 * and run again from the same moment, and the world's hash is compared before
 * the first system and after each one. `tick` throws `RewindDiverged`, naming
 * the first system after which they differ.
 *
 * This finds, in one app, what a tick reads that a rewind doesn't put back:
 * state kept in a service, a plugin or a module, or a value from outside the
 * game. In a real session it shows only once two peers drift apart.
 *
 * The rest of the game sees each tick once: the frame and input stages hear
 * each event once and see each change once, and the action log and the
 * recording hold the tick once. An action enqueued from outside is queued for
 * the next tick, as in an app no one took over.
 *
 * It costs a capture of the game, a rewind, a second run of the tick and a
 * world hash per system, each tick, so use it in tests. Like a session, it
 * takes the app over: `app.tick` throws from then on.
 *
 *   const test = Rollback.syncTest(app)
 *   for (let i = 0; i < 600; i++) test.tick(1 / 60)
 *
 * @category Constructors
 */
export const syncTest = <E>(app: SyncTestApp<E>): SyncTest<E> => {
  let checked = 0;
  // What is enqueued from outside is queued for the next tick, as it was.
  const reins: App.Diverted<E> = app.divert((name, payload) => {
    reins.deliver(name, payload);
  });
  const tickExit = (delta: number): Exit.Exit<void, E | Save.SaveRefused> => {
    const heard = app.inputExit();
    if (Exit.isFailure(heard)) {
      return heard;
    }
    const moment = Timeline.capture(app, { stages: true });
    if (Exit.isFailure(moment)) {
      return Exit.failCause(moment.cause);
    }
    // The world's hash before the first system, and after each one, by
    // where it was taken. A run that failed has none from there on.
    const run = (): {
      readonly exit: Exit.Exit<void, E>;
      readonly hashes: number[];
      readonly systems: (string | undefined)[];
    } => {
      const hashes: number[] = [];
      const systems: (string | undefined)[] = [];
      const exit = reins.tickExit(delta, (system) => {
        hashes.push(app.world.hash());
        systems.push(system);
      });
      return { exit, hashes, systems };
    };
    const first = run();
    Timeline.rewind(app, moment.value, { again: true });
    const second = run();
    const once = first.hashes;
    const twice = second.hashes;
    const length = Math.min(once.length, twice.length);
    let at = 0;
    while (at < length && once[at] === twice[at]) {
      at++;
    }
    if (at < length || once.length !== twice.length) {
      throw new RewindDiverged({
        tick: app.time.tick,
        // Where the two first differ, or where the run that went further
        // went on to and the other did not.
        system: (once.length > twice.length ? first : second).systems[at],
      });
    }
    checked++;
    return second.exit;
  };
  return {
    tickExit,
    tick(delta) {
      const exit = tickExit(delta);
      if (Exit.isFailure(exit)) {
        throw Cause.squash(exit.cause);
      }
    },
    frame: app.frame,
    get checked() {
      return checked;
    },
  };
};
