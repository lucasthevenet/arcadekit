/**
 * One peer of a game played on several machines: what it holds of what every
 * peer said, when it runs a tick, and how it goes back.
 *
 * Every peer runs the same simulation, and peers exchange only the actions
 * their players issue, each stamped with the tick it applies on. Every peer
 * applies the same actions on the same ticks in the same order, and stays in
 * the same game. A peer runs a tick once it knows what every peer issued for
 * it. With `ahead`, it runs up to that many ticks sooner, predicting that the
 * peers it hasn't heard from did nothing, and goes back when one did
 * something.
 *
 *   session.receive(message)                  // a message from another peer
 *   yield* session.tick()                     // true if the tick ran, false if it waits
 *   for (const message of session.outgoing()) send(message)
 *
 * A peer holds no socket and no timer. It receives the messages that arrived
 * and returns the ones to send, and a transport carries them, as the bytes
 * `Message.encode` writes. Every message says how far its peer has heard
 * the others. A peer keeps what it sent until every other peer has heard it,
 * and `resend` returns it to send again when a peer comes back after its
 * socket dropped.
 *
 * A peer's first message says what it was made with, `Message.Made`: the game
 * it simulates, its `delta`, the names of every peer and the tick it begins
 * at. A peer that hears another was made otherwise stops, and its tick fails
 * with `Drift.Unlike`, which says what differs. A peer the others don't name
 * is found this way too, since the names it was made with differ.
 *
 * Peers also exchange the checkpoints their logs record, the world's hash at a
 * tick. A peer that receives a different hash than its own for the same tick
 * stops, and its tick fails with `Drift.Drifted`, which reports the tick,
 * every peer's hash, and when they last agreed. Peers compare the world each
 * begins with, whatever the app's `checkpointEvery`, since a peer records a
 * checkpoint when it begins. After that, peers compare the ticks every peer's
 * log records, and with `checkpointEvery: 0`, nothing more.
 *
 * `Session.make` makes a peer with its app.
 */
import type { Effect } from "effect";

import type { Paced } from "../Driver.ts";
import type * as Save from "../Save.ts";
import type * as Drift from "./Drift.ts";
import type { Message } from "./Message.ts";

/**
 * One peer of a multiplayer game, without its app: what a driver steps, and
 * what a transport carries messages for. A driver steps it at its own
 * `delta`, as in `Driver.frames(session)`. `Session.Session` is a peer with
 * its app.
 *
 * @typeParam E What a tick of its app can fail with.
 * @category Models
 */
export interface Peer<E = never> extends Paced<
  E | Drift.Unlike | Drift.Drifted | Save.Refused
> {
  /** This peer's name. */
  readonly me: string;
  /**
   * Every peer of the game, this one too, in the order their actions are
   * applied.
   */
  readonly peers: readonly string[];
  /** The seconds a tick simulates. */
  readonly delta: number;
  /** How many ticks pass between issuing an action and applying it. */
  readonly delay: number;
  /** How many ticks the session may run past what every peer has sent. */
  readonly ahead: number;
  /**
   * Receives a message from another peer. Messages may arrive in any order and
   * more than once. It drops a message it already has, and one from a name
   * that isn't a peer of the game. A message with actions for a tick that ran
   * without it makes the next tick go back and run again from there. What a
   * first message says its peer was made with is compared with what this one
   * was made with, whoever sent it.
   */
  readonly receive: (message: Message) => void;
  /**
   * Returns the messages to send to every other peer, and removes them, so
   * the next call returns only newer ones. Every message must arrive, in any
   * order.
   */
  readonly outgoing: () => readonly Message[];
  /**
   * Returns every message this peer has sent that some other peer hasn't said
   * it heard, to send again when a peer joins the room again after its socket
   * dropped, or this one does. It keeps them until every other peer has heard
   * them. A peer drops a message that arrives twice.
   */
  readonly resend: () => readonly Message[];
  /** How many messages this peer keeps that some other peer hasn't heard. */
  readonly unheard: number;
  /**
   * Runs the next tick if this peer has every peer's message for it, and
   * succeeds with whether it ran. First it runs the input stage, as a driver
   * does before an app's tick, and what the devices issue goes into the
   * message for the tick `delay` ticks ahead. Input issued while the session
   * waits for a peer goes into its next message.
   *
   * A session that runs ahead runs a tick before every message for it is in,
   * up to `ahead` ticks past what every peer has sent. Before that, it goes
   * back over the ticks that a message with actions has since arrived for.
   *
   * The tick simulates the session's `delta`. It fails with a system's error,
   * `Drift.Unlike` once a peer has said it was made otherwise,
   * `Drift.Drifted` once the peers have drifted apart, or `Save.Refused`
   * when the game can't be captured before a tick it runs ahead. The tick
   * doesn't run then.
   */
  readonly tick: () => Effect.Effect<
    boolean,
    E | Drift.Unlike | Drift.Drifted | Save.Refused
  >;
  /**
   * Why the session stopped, once it has: a peer was made otherwise than this
   * one, or its world hashed differently from this one's at the same tick.
   * Every later tick fails with it.
   */
  readonly drifted: Drift.Unlike | Drift.Drifted | undefined;
  /** The peers whose message the next tick is still waiting for. */
  readonly waitingFor: readonly string[];
  /**
   * How many messages it holds, its own among them, for ticks that haven't
   * run or aren't final yet.
   */
  readonly held: number;
  /**
   * How many of its checkpoints are waiting for a peer's hash. A checkpoint
   * that is never answered, because no other peer records one at that tick, is
   * discarded after 600 ticks.
   */
  readonly unanswered: number;
  /**
   * The number of final ticks: every peer's messages for them have arrived, and
   * the game has run with them. Later ticks are predictions, and may be
   * resimulated differently. The frame stage draws and plays every tick as
   * it runs, final or not: a system of it that must show only what is final
   * checks this.
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
  /** The app's frame stage, for a driver to draw the game with. */
  readonly frame: (alpha: number, delta?: number) => Effect.Effect<void, E>;
}
