/**
 * Rollback: a game of several peers that does not wait for the network.
 *
 * A lockstep session runs a tick once every peer has said what it issued
 * for it, so a player sees their own move a few ticks late, and a slow
 * network slows everyone. A rollback session runs the tick at once, as if
 * the peers it has not heard from had nothing to say, which is true of
 * most ticks. When a message comes for a tick that has run, and it did
 * have something to say, the session goes back to before that tick and
 * runs forward again with what it now knows.
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
 * It is the same session as lockstep's, with the same messages, and a
 * lockstep session is one whose `ahead` is 0: it predicts no tick. So
 * everything said of `Lockstep` holds here: the session takes its app over,
 * is given the messages that arrived and gives the ones to send, is
 * stepped by a driver, and stops with `Lockstep.Drifted` when the peers
 * have come apart.
 *
 * Going back is `app.rewind`, to what `app.capture` kept before each tick
 * the session was not sure of. What a rewind does not put back is what a
 * save does not hold: see `App.rewind`.
 */
import type * as Lockstep from "./Lockstep";
import { build } from "./Lockstep";
import type * as Save from "./Save";

/**
 * How a rollback session is set up: this peer, every peer, and how far it
 * runs ahead of what it has heard.
 */
export interface Options {
  /** This peer's name. */
  readonly peer: string;
  /**
   * Every peer of the game, this one among them. Every peer is given the
   * same names, in any order.
   */
  readonly peers: readonly string[];
  /** The seconds a tick simulates: the same number on every peer. */
  readonly delta: number;
  /**
   * How many ticks lie between an action being issued and its being
   * applied: 0 when left out, so that a player's own move is in the very
   * next tick. A tick or two spares the other peers a rewind for every
   * move, at the price of that much lag on one's own.
   */
  readonly delay?: number;
  /**
   * How many ticks it may run ahead of what every peer has said: 8 when
   * left out. A peer that is that far ahead waits, as a lockstep session
   * does. It is also how far back a rewind may have to go, and how many
   * moments are kept for it.
   */
  readonly ahead?: number;
}

/**
 * One peer of a game of several, which predicts. It is a lockstep session
 * and more: `tickExit` can also fail with `Save.SaveRefused`, when the game
 * could not be captured before a tick it was not sure of.
 *
 * @param E what a tick of its app can fail with
 */
export interface Session<E = never> extends Lockstep.Session<
  E | Save.SaveRefused
> {
  /** How many ticks it may run ahead of what every peer has said. */
  readonly ahead: number;
  /**
   * How many ticks are final: every peer's messages for them are in, and
   * the game has been run with them. The ticks after it are a prediction,
   * and may be run again another way.
   */
  readonly confirmed: number;
  /** How many times it has gone back. */
  readonly rewinds: number;
  /** How many ticks it has run a second time, in all. */
  readonly resimulated: number;
  /**
   * How many moments it holds to go back to: one for each tick it ran and
   * is not sure of yet, so never more than `ahead`. Each is a snapshot of
   * the world.
   */
  readonly kept: number;
}

/**
 * Puts an app in a game of several peers, as `Lockstep.make` does, with a
 * session that runs ahead of the network and goes back when it was wrong.
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
