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
 * Rewinding uses `app.rewind`, to a moment `app.capture` took before each
 * uncertain tick. A rewind restores only what a save holds: see `App.rewind`.
 */
import type * as Lockstep from "./Lockstep";
import { build } from "./Lockstep";
import type * as Save from "./Save";

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
