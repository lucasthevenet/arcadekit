/**
 * Lockstep sessions: multiplayer games with each player on their own machine.
 *
 * Every peer runs the same simulation, and peers only exchange the actions
 * their players issue, each stamped with the tick it applies on. A peer runs a
 * tick once it knows what every peer issued for it, so all of them apply the
 * same actions on the same ticks in the same order, and stay in the same game.
 *
 *   const app = yield* App.make({ plugins: [Game], seed })
 *   const session = Lockstep.make(app, {
 *     peer: "ada",
 *     peers: ["ada", "grace"],
 *     delta: 1 / 60,
 *   })
 *
 *   app.enqueue(Move, { player: 0, dx: 1 })   // as in single player: applied on every peer
 *
 *   // Carrying messages is not the session's job:
 *   session.receive(message)                  // a message from another peer
 *   session.tick()                            // true if the tick ran, false if it waits
 *   for (const message of session.outgoing()) send(message)
 *
 * A session takes over everything that enters its app from outside
 * (`app.divert`): `app.enqueue`, a key bound to an action, a UI button. Each
 * goes into this peer's message for the tick `delay` ticks ahead, and is
 * applied on that tick by every peer, including this one. Your game therefore
 * issues input exactly as a single-player game does. What the simulation issues
 * itself with `Actions`, such as a bot's move, isn't sent: every peer's
 * simulation issues it.
 *
 * A session holds no socket and no timer. It receives the messages that arrived
 * and returns the ones to send, and a transport carries them.
 *
 * Peers also exchange the checkpoints their logs record: the world's hash at a
 * tick. A peer that receives a different hash than its own for the same tick
 * stops, and its tick fails with `Drifted`, which reports the tick, every
 * peer's hash, and when they last agreed. The starting state is compared before
 * anyone's first tick, whatever the app's `checkpointEvery`, since a session
 * records a checkpoint when it begins. After that, peers compare the ticks
 * every peer's log records, and with `checkpointEvery: 0`, nothing more.
 *
 * Every peer's log is an ordinary log, identical entry for entry, and
 * `App.replay` plays it back into a single-player game.
 */
import { Cause, Data, Exit, Schema } from "effect";

import * as Action from "./Action";
import type * as App from "./App";
import type { Tickable } from "./Driver";
import type * as Save from "./Save";

/**
 * An action as a peer issued it: its name, and its payload in JSON form.
 *
 * @category Models
 */
export interface Issued {
  readonly name: string;
  readonly payload: unknown;
}

/**
 * What peers send each other: everything one peer issued for one tick. Every
 * peer sends one for every tick, usually with no actions in it: it is also how
 * a peer says it has nothing more for that tick.
 *
 * @category Models
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
  /**
   * The checkpoints the peer's log recorded since its last message: its world's
   * hash, and at which tick. Omitted when there are none.
   */
  readonly checkpoints?: readonly Action.Checkpoint[];
}

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const MessageSchema = Schema.fromJsonString(
  Schema.Struct({
    from: Schema.String,
    tick: Count,
    actions: Schema.Array(
      Schema.Struct({ name: Schema.String, payload: Schema.Unknown })
    ),
    checkpoints: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          tick: Count,
          hash: Schema.Int.check(
            Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 })
          ),
        })
      )
    ),
  })
);

/**
 * The peers are no longer playing the same game: at one tick, their worlds'
 * hashes differed. Every later tick of the session fails with this error.
 *
 * Drift is detected within a bounded number of ticks. A checkpoint is recorded
 * every `checkpointEvery` ticks and travels with the message for the tick
 * `delay` ahead, which no peer can run without. So no peer runs more than
 * `checkpointEvery - 1 + delay` ticks past the first tick whose world differed,
 * where `delay` is the largest any peer uses. A session that runs ahead,
 * `Rollback`, sends a tick's hash once every peer has sent their actions for
 * it, so there the bound is `checkpointEvery - 1 + delay + 2 × ahead` ticks.
 *
 * What is compared is the world's hash. What the hash doesn't cover, such as an
 * event only one peer has waiting or a system's own variables, is only detected
 * once it affects the world.
 *
 * @category Errors
 */
export class Drifted extends Data.TaggedError("Drifted")<{
  /** The tick of the first checkpoint whose hashes differ. */
  readonly tick: number;
  /** The peer that detected it: this one. */
  readonly peer: string;
  /**
   * Every peer's world hash at that tick, by name. Look at the peer whose hash
   * differs from the others.
   */
  readonly hashes: Readonly<Record<string, number>>;
  /** The last tick at which every peer's hash matched, if any. */
  readonly agreedAt: number | undefined;
}> {
  override get message(): string {
    const hashes = Object.entries(this.hashes)
      .map(([name, hash]) => `${name} ${hash}`)
      .join(", ");
    const since =
      this.agreedAt === undefined
        ? "No earlier checkpoint matched, so they did not start from the same state: check that every peer was made with the same plugins and the same seed, and spawned the same things before its first tick"
        : `They last agreed at tick ${this.agreedAt}, so they came apart in one of the ${this.tick - this.agreedAt} ticks after it: look for a system, a handler or a script that reads what is not in the world (Math.random, a clock, a service that keeps state of its own, the order of a Map or a Set), or for peers that were not made alike (a plugin, the delta)`;
    return `The peers are no longer playing the same game. At tick ${this.tick} the hashes of their worlds are: ${hashes} (found by "${this.peer}"). ${since}.`;
  }
}

/**
 * Encodes a message as text, for whatever carries it.
 *
 * @category Codecs
 */
export const encode = (message: Message): string => JSON.stringify(message);

/**
 * Decodes a message from text. It checks the message's own structure; each
 * payload is validated against its action's schema when the action is applied,
 * and a payload that fails is refused by every peer alike.
 *
 * @category Codecs
 */
export const decode = (text: string): Exit.Exit<Message, Schema.SchemaError> =>
  Schema.decodeExit(MessageSchema)(text);

/**
 * Options for a lockstep session: this peer, every peer, and how many ticks
 * ahead an action is sent.
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
   * 2. A message has that long to reach the other peers before they have to
   * wait for it. A non-negative integer, which may differ from peer to peer.
   */
  readonly delay?: number;
}

/**
 * One peer of a multiplayer game. A driver steps it as it steps an app:
 * `Driver.frames(session, { hz })`.
 *
 * @param E what a tick of its app can fail with
 *
 * @category Models
 */
export interface Session<E = never> extends Tickable {
  readonly peer: string;
  /** Every peer of the game, in the order their actions are applied. */
  readonly peers: readonly string[];
  /** The seconds a tick simulates. */
  readonly delta: number;
  /** How many ticks pass between issuing an action and applying it. */
  readonly delay: number;
  /**
   * Receives a message from another peer. Messages may arrive in any order and
   * more than once: a duplicate, a message for a tick that already ran, or one
   * from a name that isn't a peer of the game is dropped.
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
   * Throws if a system fails, or if the peers have drifted apart. When given a
   * number, as a driver does, it must equal the session's `delta`.
   */
  readonly tick: (delta?: number) => boolean;
  /**
   * Like `tick`, but returns a failure, typed: a system's error, or `Drifted`
   * once the peers have drifted apart.
   */
  readonly tickExit: (delta?: number) => Exit.Exit<boolean, E | Drifted>;
  /**
   * Why the session stopped, once it has: a peer's world hashed differently
   * from this one's at the same tick. Every later tick fails with it.
   */
  readonly drifted: Drifted | undefined;
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
  /** The app's frame stage, for a driver to draw the game with. */
  readonly frame: (alpha: number, delta?: number) => void;
}

/** How many ticks an unanswered checkpoint is kept. */
const UNANSWERED = 600;

/** Orders names by code unit, which is the same on every machine. */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Makes a lockstep session for an app. The app must be created like every other
 * peer's: the same plugins, the same seed, and the same starting state.
 *
 * From then on the session steps the app: the app's own `tick` and `dispatch`
 * throw, since either would advance this peer's game alone. The session begins
 * at whatever tick the app is at, so a game can continue from a save every peer
 * loaded.
 *
 * **Gotchas**
 *
 * - It throws when the options can't describe a game: a peer not among `peers`,
 *   two peers with the same name, a `delay` that isn't a whole number of ticks,
 *   or a `delta` that isn't greater than 0.
 * - An action that must reach the other peers needs a schema. Enqueuing one
 *   defined with only a type throws.
 * - A payload its schema rejects has no JSON form to send: it is refused on the
 *   issuing peer only, and the others never see it.
 * - Each peer is configured with its own plugins, seed, `delta` and names, and
 *   none of these is compared directly, only the worlds they produce. A
 *   different `delta` or list of names is detected once it has changed a world,
 *   and a list that leaves a peer out is never detected.
 *
 * @category Constructors
 */
export const make = <E>(app: SessionApp<E>, options: Options): Session<E> =>
  // A lockstep session predicts nothing, so it captures nothing, and a
  // capture is all that fails with `SaveRefused`.
  build(app, {
    ...options,
    delay: options.delay ?? 2,
    ahead: 0,
  }) as Session<E>;

/**
 * What a session needs from its app. Every app provides it.
 *
 * @category Type-level
 */
export type SessionApp<E> = Pick<
  App.App<E>,
  | "actionLog"
  | "capture"
  | "checkpoint"
  | "divert"
  | "frame"
  | "inputExit"
  | "rewind"
  | "time"
>;

/**
 * What a predicting session adds, as `Rollback.Session` documents.
 *
 * @category Models
 */
export interface Predicting {
  readonly ahead: number;
  readonly confirmed: number;
  readonly rewinds: number;
  readonly resimulated: number;
  readonly kept: number;
}

/**
 * The one session there is. Lockstep is the session that predicts no tick:
 * `ahead` is 0. `Rollback.make` lets it run ahead, and it then runs up to
 * that many ticks past what it knows and goes back when it was
 * wrong.
 * @internal
 */
export const build = <E>(
  app: SessionApp<E>,
  options: Options & { readonly delay: number; readonly ahead: number }
): Session<E | Save.SaveRefused> & Predicting => {
  const { delay, delta, peer, ahead } = options;
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
  const reins = app.divert(
    (name, payload) => {
      issued.push({ name, payload });
    },
    { rewinds: ahead > 0 }
  );

  const start = app.time.tick;
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
      if (unsent.length === 0) {
        outbox.push({ from: peer, tick, actions });
      } else {
        outbox.push({ from: peer, tick, actions, checkpoints: unsent });
        unsent = [];
      }
    }
  };

  // --- prediction: ticks run before every peer's message was in -------------
  // The game as it was before each such tick, to go back to.
  const moments = new Map<number, App.Moment>();
  // The earliest tick that ran without a message which has come since,
  // with actions in it: the game is wrong from there.
  let wrong: number | undefined;
  let rewinds = 0;
  let resimulated = 0;

  // --- drift: the peers compare the checkpoints their logs record ----------
  // The hashes this peer's log recorded at ticks that are not final yet.
  const taken = new Map<number, number>();
  // This peer's final hashes, by tick, until every peer has answered them.
  const mine = new Map<number, number>();
  // The other peers' hashes, by tick and then by name.
  const theirs = new Map<number, Map<string, number>>();
  // Per peer, the checkpoints of messages that came ahead of an earlier
  // one, and the tick of the next message to take checkpoints from. A
  // peer's checkpoints are taken in the order it sent them, so that the
  // last tick the peers agreed at is known when the next one differs.
  const early = new Map<string, Map<number, readonly Action.Checkpoint[]>>();
  const next = new Map<string, number>();
  for (const name of peers) {
    early.set(name, new Map());
    next.set(name, start);
  }
  let unsent: Action.Checkpoint[] = [];
  let drifted: Drifted | undefined;
  let agreedAt: number | undefined;
  let begun = false;

  /**
   * Finalizes the hashes of final ticks, and compares every checkpoint that
   * this peer and all the others have.
   */
  const compare = (): void => {
    if (drifted !== undefined || wrong !== undefined) {
      return;
    }
    const final = Math.min(known(), app.time.tick);
    for (const tick of Array.from(taken.keys()).toSorted((a, b) => a - b)) {
      if (tick > final) {
        break;
      }
      const hash = taken.get(tick)!;
      taken.delete(tick);
      mine.set(tick, hash);
      unsent.push({ tick, hash });
    }
    // One that no peer has answered in all that time is let go of.
    for (const tick of mine.keys()) {
      if (tick >= app.time.tick - UNANSWERED) {
        break;
      }
      mine.delete(tick);
      theirs.delete(tick);
    }
    for (const tick of Array.from(theirs.keys()).toSorted((a, b) => a - b)) {
      if (tick > final) {
        // This peer is not sure of that tick yet.
        break;
      }
      const said = theirs.get(tick)!;
      const hash = mine.get(tick);
      if (hash === undefined) {
        // Nothing to hold it against: a checkpoint the other peer took by
        // hand, or one of a schedule that is not this peer's.
        theirs.delete(tick);
        continue;
      }
      if (said.size < peers.length - 1) {
        // Once every peer has said, so that the report is whole. No tick
        // is lost by it: their words for this tick come with messages
        // that this peer cannot run far past.
        continue;
      }
      mine.delete(tick);
      theirs.delete(tick);
      const hashes: Record<string, number> = {};
      let same = true;
      for (const name of peers) {
        const other: number = name === peer ? hash : said.get(name)!;
        hashes[name] = other;
        same &&= other === hash;
      }
      if (!same) {
        drifted = new Drifted({ tick, peer, hashes, agreedAt });
        return;
      }
      agreedAt = tick;
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
      const moment = app.capture();
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
      taken.set(last.tick, last.hash);
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

  /** Stops the session, after sending the hash the others are missing. */
  const stop = (reason: Drifted): Exit.Exit<never, Drifted> => {
    say(app.time.tick);
    return Exit.fail(reason);
  };

  const tickExit = (
    given?: number
  ): Exit.Exit<boolean, E | Drifted | Save.SaveRefused> => {
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
      taken.set(
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
      app.rewind(moments.get(from)!);
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
    if (drifted !== undefined) {
      return stop(drifted);
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
    if (drifted !== undefined && Exit.isSuccess(exit)) {
      return stop(drifted);
    }
    return Exit.map(exit, () => true);
  };

  return {
    peer,
    peers,
    delta,
    delay,
    ahead,
    receive(message) {
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
      // Its checkpoints, once every message it sent before this one is in.
      const waiting = early.get(message.from)!;
      waiting.set(message.tick, message.checkpoints ?? []);
      let expected = next.get(message.from)!;
      for (
        let checkpoints = waiting.get(expected);
        checkpoints !== undefined;
        checkpoints = waiting.get(expected)
      ) {
        waiting.delete(expected++);
        for (const { hash, tick } of checkpoints) {
          let said = theirs.get(tick);
          if (said === undefined) {
            said = new Map();
            theirs.set(tick, said);
          }
          said.set(message.from, hash);
        }
      }
      next.set(message.from, expected);
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
      return drifted;
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
      return mine.size;
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
