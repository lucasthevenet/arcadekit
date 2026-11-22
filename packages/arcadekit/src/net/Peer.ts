/**
 * One peer of a game played on several machines: what it holds of what every
 * peer said, when it runs a tick, and how it goes back.
 *
 * Every peer runs the same simulation, and peers only exchange the actions
 * their players issue, each stamped with the tick it applies on. Every peer
 * applies the same actions on the same ticks in the same order, and stays in
 * the same game. A peer runs a tick once it knows what every peer issued for
 * it, or up to `ahead` ticks before, predicting that the peers it hasn't
 * heard from did nothing and going back when one had.
 *
 *   session.receive(message)                  // a message from another peer
 *   session.tick()                            // true if the tick ran, false if it waits
 *   for (const message of session.outgoing()) send(message)
 *
 * A peer holds no socket and no timer. It receives the messages that arrived
 * and returns the ones to send, and a transport carries them, as text in the
 * form `Message.encode` writes.
 *
 * A peer's first message says what it was made with, `Message.Made`: the game
 * it simulates, its `delta`, the names of every peer and the tick it begins
 * at. A peer that hears another made otherwise stops, and its tick fails with
 * `Drift.Unlike`, which says what differs. A name that isn't among its peers
 * is told apart this way too, since that peer's names are other ones.
 *
 * Peers also exchange the checkpoints their logs record: the world's hash at a
 * tick. A peer that receives a different hash than its own for the same tick
 * stops, and its tick fails with `Drift.Drifted`, which reports the tick,
 * every peer's hash, and when they last agreed. The starting state is
 * compared before anyone's first tick, whatever the app's `checkpointEvery`,
 * since a peer records a checkpoint when it begins. After that, peers compare
 * the ticks every peer's log records, and with `checkpointEvery: 0`, nothing
 * more.
 *
 * `Session.make` makes a peer with its app.
 */
import { Cause, Exit } from "effect";

import * as Action from "../Action";
import type * as App from "../App";
import type { Reins } from "../Build";
import type { Tickable } from "../Driver";
import type * as Save from "../Save";
import * as Timeline from "../Timeline";
import * as Drift from "./Drift";
import type { Issued, Made, Message } from "./Message";

/**
 * What a peer is told of its game: what it simulates, as `Message.Made`'s
 * `game` hashes it, who it is, who plays, how long a tick is, and how far it
 * sends and runs ahead. `Session.Options` documents the rest.
 *
 * @internal
 */
export interface Options {
  readonly game: number;
  readonly peer: string;
  readonly peers: readonly string[];
  readonly delta: number;
  readonly delay: number;
  readonly ahead: number;
}

/**
 * One peer of a multiplayer game, without its app: what a driver steps and a
 * transport carries the messages of. A driver steps it as it steps an app:
 * `Driver.frames(session, { hz })`. `Session.Session` is a peer with its app.
 *
 * @param E what a tick of its app can fail with
 *
 * @category Models
 */
export interface Peer<E = never> extends Tickable {
  readonly peer: string;
  /** Every peer of the game, in the order their actions are applied. */
  readonly peers: readonly string[];
  /** The seconds a tick simulates. */
  readonly delta: number;
  /** How many ticks pass between issuing an action and applying it. */
  readonly delay: number;
  /** How many ticks the session may run past what every peer has sent. */
  readonly ahead: number;
  /**
   * Receives a message from another peer. Messages may arrive in any order and
   * more than once: a duplicate, a message for a tick that already ran, or one
   * from a name that isn't a peer of the game is dropped. What a first message
   * says the peer was made with is compared with this one's, whoever sent it.
   */
  readonly receive: (message: Message) => void;
  /**
   * Returns the messages to send to every other peer, and removes them: the
   * next call returns only newer ones. Every message must arrive, in any order.
   */
  readonly outgoing: () => readonly Message[];
  /**
   * Runs the next tick if this peer has every peer's message for it, and
   * returns whether it ran. First it reads the devices, as an app's own tick
   * does, and what they issue goes into the message for the tick `delay` ticks
   * ahead. Input issued while the session waits for a peer goes into its next
   * message.
   *
   * A session that runs ahead runs the tick before every message for it is
   * in, up to `ahead` ticks past what every peer has sent, and first goes
   * back over the ticks a message has since arrived for.
   *
   * Throws if a system fails, or if the peers have drifted apart. When given a
   * number, as a driver does, it must equal the session's `delta`.
   */
  readonly tick: (delta?: number) => boolean;
  /**
   * Like `tick`, but returns a failure, typed: a system's error, `Unlike`
   * once a peer has said it was made otherwise, `Drifted` once the peers have
   * drifted apart, or `Save.SaveRefused` when the game can't be captured
   * before a tick that runs ahead, in which case the tick doesn't run.
   */
  readonly tickExit: (
    delta?: number
  ) => Exit.Exit<boolean, E | Drift.Unlike | Drift.Drifted | Save.SaveRefused>;
  /**
   * Why the session stopped, once it has: a peer was made otherwise than this
   * one, or its world hashed differently from this one's at the same tick.
   * Every later tick fails with it.
   */
  readonly drifted: Drift.Unlike | Drift.Drifted | undefined;
  /** The peers whose message the next tick is still waiting for. */
  readonly waitingFor: readonly string[];
  /**
   * How many messages it holds for ticks that haven't run, including its own:
   * how far ahead of the game the peers have sent.
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
  /** The app's frame stage, for a driver to draw the game with. */
  readonly frame: (alpha: number, delta?: number) => void;
}

/** Orders names by code unit, which is the same on every machine. */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What a peer needs from its app. Every app provides it.
 *
 * @internal
 */
export type PeerApp<E> = Pick<
  App.App<E>,
  "actionLog" | "checkpoint" | "frame" | "inputExit"
> &
  Timeline.Game;

/**
 * Makes the peer of an app that has been taken over for it: `take` is given
 * what receives each action issued from outside, and returns the reins of
 * the app. It is the one session there is: one that predicts no tick has an
 * `ahead` of 0.
 *
 * @internal
 */
export const build = <E, A extends PeerApp<E>>(
  app: A,
  take: (issued: (name: string, payload: unknown) => void) => Reins<E>,
  options: Options
): Peer<E> & { readonly app: A } => {
  const { ahead, delay, delta, game, peer } = options;
  if (!Number.isSafeInteger(delay) || delay < 0) {
    throw new Error(
      `A session's delay is a whole number of ticks, 0 or more, and this one is ${delay}.`
    );
  }
  if (!Number.isSafeInteger(ahead) || ahead < 0) {
    throw new Error(
      `How far a session runs ahead is a whole number of ticks, 0 or more, and this one is ${ahead}.`
    );
  }
  if (!(delta > 0) || !Number.isFinite(delta)) {
    throw new Error(
      `A session's delta is the seconds a tick simulates, more than 0, and this one is ${delta}.`
    );
  }
  const peers = options.peers.toSorted(byName);
  if (new Set(peers).size !== peers.length) {
    throw new Error(
      `Two peers of a session have the same name: ${peers.join(", ")}.`
    );
  }
  if (!peers.includes(peer)) {
    throw new Error(
      `The peer "${peer}" is not among the peers of its own session: ${peers.join(", ")}. Every peer is given the names of all of them, its own among them.`
    );
  }

  // What this peer issued and has not put in a message yet.
  let issued: Issued[] = [];
  const reins = take((name, payload) => {
    issued.push({ name, payload });
  });

  const start = app.time.tick;
  const made: Made = { game, delta, peers, start };
  // Per peer, the actions of each tick that may still have to be run.
  const held = new Map<string, Map<number, readonly Issued[]>>();
  // Per peer, the first tick its message is missing for: every one before
  // it is in. This peer's own is the first tick it has made none for.
  const have = new Map<string, number>();
  for (const name of peers) {
    held.set(name, new Map());
    have.set(name, start);
  }
  const own = held.get(peer)!;
  let outbox: Message[] = [];

  /** Returns how many ticks every peer's messages have arrived for: those ticks are final. */
  const known = (): number => {
    let least = Number.POSITIVE_INFINITY;
    for (const next of have.values()) {
      least = Math.min(least, next);
    }
    return least;
  };

  /** Creates this peer's messages up to the tick `delay` ahead of `now`. */
  const say = (now: number): void => {
    for (let tick = have.get(peer)!; tick <= now + delay; tick++) {
      // What was issued up to now applies on the last of them. The ones
      // before it, which only a session's first tick has, are empty.
      const actions = tick === now + delay ? issued : [];
      if (tick === now + delay) {
        issued = [];
      }
      own.set(tick, actions);
      have.set(peer, tick + 1);
      // The checkpoints go with the first message there is to send.
      const checkpoints = drift.unsent();
      outbox.push({
        from: peer,
        tick,
        actions,
        ...(checkpoints.length === 0 ? {} : { checkpoints }),
        ...(tick === start ? { made } : {}),
      });
    }
  };

  // --- prediction: ticks run before every peer's message was in -------------
  // The game as it was before each such tick, to go back to.
  const moments = new Map<number, Timeline.Moment>();
  // The earliest tick that ran without a message which has come since,
  // with actions in it: the game is wrong from there.
  let wrong: number | undefined;
  let rewinds = 0;
  let resimulated = 0;

  // --- drift: the peers compare the checkpoints their logs record ----------
  const drift = Drift.make({ peer, made });
  let begun = false;

  /**
   * Compares every checkpoint that this peer and all the others have, up
   * to the last final tick. Not while a tick is known to be wrong: its hash
   * is of a game that is about to be run again.
   */
  const compare = (): void => {
    if (wrong === undefined) {
      drift.compare(Math.min(known(), app.time.tick), app.time.tick);
    }
  };

  /** Runs one tick with the actions known for it. */
  const run = (tick: number): Exit.Exit<void, E | Save.SaveRefused> => {
    let whole = true;
    for (const next of have.values()) {
      whole &&= next > tick;
    }
    if (whole) {
      moments.delete(tick);
    } else {
      // A peer has not said: the tick is run as if it had nothing to say,
      // and the game is kept as it was, to go back to if it had.
      const moment = Timeline.capture(app);
      if (Exit.isFailure(moment)) {
        return Exit.failCause(moment.cause);
      }
      moments.set(tick, moment.value);
    }
    // Every peer applies the tick's actions in the same order: peer by
    // peer in order of name, and each peer's in the order it issued them.
    for (const name of peers) {
      for (const action of held.get(name)!.get(tick) ?? []) {
        reins.deliver(action.name, action.payload, name);
      }
    }
    const exit = reins.tickExit(delta);
    // The checkpoint the tick recorded, if it did.
    const last = app.actionLog.at(-1);
    if (
      last !== undefined &&
      Action.isCheckpoint(last) &&
      last.tick === app.time.tick
    ) {
      drift.took(last.tick, last.hash);
    }
    return exit;
  };

  /** Releases what no tick will need again. */
  const prune = (): void => {
    const final = Math.min(known(), app.time.tick);
    for (const turns of held.values()) {
      for (const tick of turns.keys()) {
        if (tick >= final) {
          break;
        }
        turns.delete(tick);
      }
    }
    for (const tick of moments.keys()) {
      if (tick < final) {
        moments.delete(tick);
      }
    }
  };

  /** Stops the session, after sending what the others are missing. */
  const stop = <R extends Drift.Unlike | Drift.Drifted>(
    reason: R
  ): Exit.Exit<never, R> => {
    say(app.time.tick);
    return Exit.fail(reason);
  };

  const tickExit = (
    given?: number
  ): Exit.Exit<
    boolean,
    E | Drift.Unlike | Drift.Drifted | Save.SaveRefused
  > => {
    if (given !== undefined && Math.abs(given - delta) > 1e-9) {
      throw new Error(
        `A session's tick was given a delta of ${given}, and the session ticks ${delta} seconds at a time, as every peer of it does. Give its driver hz: ${1 / delta}.`
      );
    }
    const now = app.time.tick;
    if (!begun) {
      begun = true;
      // The state the peers start from is the first thing they compare,
      // whatever the app's `checkpointEvery`: no tick runs before it.
      const last = app.actionLog.at(-1);
      drift.took(
        now,
        last !== undefined && Action.isCheckpoint(last) && last.tick === now
          ? last.hash
          : app.checkpoint()
      );
    }
    let failed: Exit.Exit<never, E | Save.SaveRefused> | undefined;
    if (wrong !== undefined) {
      // A message came for a tick that had run without it. Back to before
      // that tick, and forward again with what is known now.
      const from = wrong;
      wrong = undefined;
      Timeline.rewind(app, moments.get(from)!, { again: true });
      rewinds++;
      for (let tick = from; tick < now; tick++) {
        const exit = run(tick);
        resimulated++;
        if (Exit.isFailure(exit)) {
          failed ??= Exit.failCause(exit.cause);
          if (app.time.tick === tick) {
            // The tick did not run at all: it could not be captured.
            return failed;
          }
        }
      }
    }
    compare();
    prune();
    if (drift.drifted !== undefined) {
      return stop(drift.drifted);
    }
    if (failed !== undefined) {
      return failed;
    }
    // The devices next: what they issue goes into this tick's message.
    const heard = app.inputExit();
    if (Exit.isFailure(heard)) {
      return Exit.failCause(heard.cause);
    }
    say(now);
    // No further than `ahead` ticks past what every peer has said.
    if (now - known() >= ahead) {
      return Exit.succeed(false);
    }
    const exit = run(now);
    if (Exit.isFailure(exit) && app.time.tick === now) {
      return Exit.failCause(exit.cause);
    }
    // The checkpoint this tick recorded, against what the others said of it.
    compare();
    if (drift.drifted !== undefined && Exit.isSuccess(exit)) {
      return stop(drift.drifted);
    }
    return Exit.map(exit, () => true);
  };

  return {
    app,
    peer,
    peers,
    delta,
    delay,
    ahead,
    receive(message) {
      if (message.made !== undefined) {
        drift.told(message.from, message.made);
      }
      const turns = held.get(message.from);
      if (
        turns === undefined ||
        message.from === peer ||
        message.tick < have.get(message.from)! ||
        turns.has(message.tick)
      ) {
        return;
      }
      turns.set(message.tick, message.actions);
      let first = have.get(message.from)!;
      while (turns.has(first)) {
        first++;
      }
      have.set(message.from, first);
      // A tick that ran without it, and it had something to say.
      if (message.tick < app.time.tick && message.actions.length > 0) {
        wrong = Math.min(wrong ?? message.tick, message.tick);
      }
      drift.heard(message.from, message.tick, message.checkpoints ?? []);
      if (begun) {
        compare();
      }
    },
    outgoing() {
      const messages = outbox;
      outbox = [];
      return messages;
    },
    tickExit,
    tick(given) {
      const exit = tickExit(given);
      if (Exit.isFailure(exit)) {
        throw Cause.squash(exit.cause);
      }
      return exit.value;
    },
    get drifted() {
      return drift.drifted;
    },
    get waitingFor() {
      // The tick that has to be whole before the next one may run.
      const needed = app.time.tick - ahead;
      return peers.filter((name) => name !== peer && have.get(name)! <= needed);
    },
    get held() {
      let count = 0;
      for (const turns of held.values()) {
        count += turns.size;
      }
      return count;
    },
    get unanswered() {
      return drift.unanswered;
    },
    get confirmed() {
      return wrong === undefined
        ? Math.min(known(), app.time.tick)
        : Math.min(known(), wrong);
    },
    get rewinds() {
      return rewinds;
    },
    get resimulated() {
      return resimulated;
    },
    get kept() {
      return moments.size;
    },
    frame: app.frame,
  };
};
