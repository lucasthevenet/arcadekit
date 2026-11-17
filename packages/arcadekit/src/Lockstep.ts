/**
 * Lockstep: more than one player, each on a machine of their own.
 *
 * Every peer runs the same simulation, and what they send each other is the
 * actions their players issue and nothing else, each stamped with the tick
 * it applies on. A peer runs a tick once it knows what every peer issued
 * for it, so all of them apply the same actions on the same ticks, in the
 * same order, and stay the same game.
 *
 *   const app = yield* App.make({ plugins: [Game], seed })
 *   const session = Lockstep.make(app, {
 *     peer: "ada",
 *     peers: ["ada", "grace"],
 *     delta: 1 / 60,
 *   })
 *
 *   app.enqueue(Move, { player: 0, dx: 1 })   // as in a game of one: applied on every peer
 *
 *   // What carries the messages is not the session's business:
 *   session.receive(message)                  // one that came from another peer
 *   session.tick()                            // true if the tick ran, false if it waits
 *   for (const message of session.outgoing()) send(message)
 *
 * A session takes over what comes into its app from outside (`app.divert`):
 * `app.enqueue`, a key bound to an action, a button of the UI. Each is put
 * in this peer's message for the tick `delay` ticks ahead, and applied on
 * that tick by every peer, this one among them. So the game issues its
 * input as a game of one does.
 *
 * A session holds no socket and no timer. It is given the messages that
 * arrived and gives the ones to send, and a transport carries them.
 */
import { Cause, Exit, Schema } from "effect";

import type * as App from "./App";
import type { Tickable } from "./Driver";

/** An action as a peer issued it: its name, and its payload in JSON form. */
export interface Issued {
  readonly name: string;
  readonly payload: unknown;
}

/**
 * What peers send each other: everything one peer issued for one tick.
 * There is one from every peer for every tick, with no action in it more
 * often than not: it is also how a peer says it has nothing more for that
 * tick.
 */
export interface Message {
  /** The peer that issued the actions. */
  readonly from: string;
  /**
   * The tick they apply on: the one that runs once this many ticks have
   * completed, on every peer.
   */
  readonly tick: number;
  /** The actions, in the order the peer issued them. */
  readonly actions: readonly Issued[];
}

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const MessageSchema = Schema.fromJsonString(
  Schema.Struct({
    from: Schema.String,
    tick: Count,
    actions: Schema.Array(
      Schema.Struct({ name: Schema.String, payload: Schema.Unknown })
    ),
  })
);

/** A message as text, for whatever carries it. */
export const encode = (message: Message): string => JSON.stringify(message);

/**
 * Reads a message back from text. This checks the message's own shape; each
 * payload is checked against its action's schema when the action is
 * applied, and one that does not pass is refused by every peer alike.
 */
export const decode = (text: string): Exit.Exit<Message, Schema.SchemaError> =>
  Schema.decodeUnknownExit(MessageSchema)(text) as Exit.Exit<
    Message,
    Schema.SchemaError
  >;

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
   * applied: 2 when left out. A message has that long to reach the other
   * peers before they have to wait for it. A whole number, 0 or more.
   */
  readonly delay?: number;
}

/**
 * One peer of a game of several. A driver steps it as it steps an app:
 * `Driver.frames(session, { hz })`.
 *
 * @param E what a tick of its app can fail with
 */
export interface Session<E = never> extends Tickable {
  readonly peer: string;
  /** Every peer of the game, in the order their actions are applied in. */
  readonly peers: readonly string[];
  /** The seconds a tick simulates. */
  readonly delta: number;
  /** How many ticks lie between an action being issued and applied. */
  readonly delay: number;
  /**
   * Takes a message that came from another peer. In any order, and more
   * than once: one that is already held, or is for a tick that has run, is
   * dropped, and so is one from a name that is no peer of the game.
   */
  readonly receive: (message: Message) => void;
  /**
   * The messages to send to every other peer. They are taken: asked again,
   * it gives the ones made since. Every one has to arrive, in whatever
   * order.
   */
  readonly outgoing: () => readonly Message[];
  /**
   * Runs the next tick, if this peer has every peer's message for it, and
   * says whether it did. Before that it hears the devices, as an app's own
   * tick does, and what they issue is in the message it makes for the tick
   * `delay` ticks ahead.
   *
   * Throws if a system fails. Given a number, as a driver gives one, it
   * has to be the session's `delta`.
   */
  readonly tick: (delta?: number) => boolean;
  /** As `tick`, with a system's failure returned and typed. */
  readonly tickExit: (delta?: number) => Exit.Exit<boolean, E>;
  /** The peers whose message the next tick is still waiting for. */
  readonly waitingFor: readonly string[];
  /**
   * How many messages it holds for ticks that have not run, its own among
   * them: how far ahead of the game the peers have spoken.
   */
  readonly held: number;
  /** The app's frame stage, for a driver to draw the game with. */
  readonly frame: (alpha: number, delta?: number) => void;
}

/** In order of name, by code unit: the same on every machine. */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Puts an app in a game of several peers. The app is one that was made
 * like every other peer's: the same plugins, the same seed, and the same
 * state to start from.
 *
 * From here on the session steps the app: the app's own `tick` and
 * `dispatch` throw, since either would move this peer's game alone.
 */
export const make = <E>(
  app: Pick<App.App<E>, "divert" | "frame" | "inputExit" | "time">,
  options: Options
): Session<E> => {
  const { delta, peer } = options;
  const delay = options.delay ?? 2;
  if (!Number.isSafeInteger(delay) || delay < 0) {
    throw new Error(
      `A session's delay is a whole number of ticks, 0 or more, and this one is ${delay}.`
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
  const reins = app.divert((name, payload) => {
    issued.push({ name, payload });
  });

  // Per peer, the actions of each tick that has not run yet.
  const held = new Map<string, Map<number, readonly Issued[]>>();
  for (const name of peers) {
    held.set(name, new Map());
  }
  const own = held.get(peer)!;
  let outbox: Message[] = [];
  // The first tick this peer has made no message for.
  let unsaid = app.time.tick;

  /** Makes this peer's messages up to the tick `delay` ahead of `now`. */
  const say = (now: number): void => {
    while (unsaid <= now + delay) {
      const tick = unsaid++;
      // What was issued up to now applies on the last of them. The ones
      // before it, which only a session's first tick has, are empty.
      const actions = tick === now + delay ? issued : [];
      if (tick === now + delay) {
        issued = [];
      }
      own.set(tick, actions);
      outbox.push({ from: peer, tick, actions });
    }
  };

  const waitingFor = (now: number): string[] =>
    peers.filter((name) => !held.get(name)!.has(now));

  const tickExit = (given?: number): Exit.Exit<boolean, E> => {
    if (given !== undefined && Math.abs(given - delta) > 1e-9) {
      throw new Error(
        `A session's tick was given a delta of ${given}, and the session ticks ${delta} seconds at a time, as every peer of it does. Give its driver hz: ${1 / delta}.`
      );
    }
    // The devices first: what they issue goes into this tick's message.
    const heard = app.inputExit();
    if (Exit.isFailure(heard)) {
      return Exit.failCause(heard.cause);
    }
    const now = app.time.tick;
    say(now);
    if (waitingFor(now).length > 0) {
      return Exit.succeed(false);
    }
    // Every peer applies the tick's actions in the same order: peer by
    // peer in order of name, and each peer's in the order it issued them.
    for (const name of peers) {
      const turns = held.get(name)!;
      for (const action of turns.get(now)!) {
        reins.deliver(action.name, action.payload);
      }
      turns.delete(now);
    }
    return Exit.map(reins.tickExit(delta), () => true);
  };

  return {
    peer,
    peers,
    delta,
    delay,
    receive(message) {
      const turns = held.get(message.from);
      if (
        turns === undefined ||
        message.tick < app.time.tick ||
        turns.has(message.tick)
      ) {
        return;
      }
      turns.set(message.tick, message.actions);
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
    get waitingFor() {
      return waitingFor(app.time.tick).filter((name) => name !== peer);
    },
    get held() {
      let count = 0;
      for (const turns of held.values()) {
        count += turns.size;
      }
      return count;
    },
    frame: app.frame,
  };
};
