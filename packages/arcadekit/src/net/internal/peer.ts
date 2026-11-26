import { Effect, Exit } from "effect";

import * as Action from "../../Action.ts";
import type * as App from "../../App.ts";
import type { Reins } from "../../internal/build.ts";
import type * as Save from "../../Save.ts";
import * as Timeline from "../../Timeline.ts";
import * as Drift from "../Drift.ts";
import type { Issued, Made, Message } from "../Message.ts";
import type { Session } from "../Session.ts";

/**
 * What a peer is told of its game: what it simulates, as `Message.Made`'s
 * `game` hashes it, who it is, who plays, how many ticks a second, and how far it
 * sends and runs ahead. `Session.Options` documents the rest.
 *
 * @internal
 */
export interface Options {
  readonly game: number;
  readonly me: string;
  readonly others: readonly string[];
  readonly hz: number;
  readonly delay: number;
  readonly ahead: number;
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
  "actionLog" | "checkpoint" | "close" | "frame" | "input"
> &
  Timeline.Game;

/**
 * Makes the peer of an app that has been taken over for it: `take` is given
 * what receives each action issued from outside, and returns the reins of
 * the app. It is the one session there is: one that predicts no tick has an
 * `ahead` of 0. Its `close` closes the app, and its `app` is the app it was
 * given.
 *
 * @internal
 */
export const build = <E, A extends PeerApp<E>>(
  app: A,
  take: (issued: (name: string, payload: unknown) => void) => Reins<E>,
  options: Options
): Omit<Session<E>, "app"> & { readonly app: A } => {
  const { ahead, delay, game, hz, me: peer } = options;
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
  if (!(hz > 0) || !Number.isFinite(hz)) {
    throw new Error(
      `A session's hz is the ticks a second it runs at, more than 0, and this one is ${hz}.`
    );
  }
  const delta = 1 / hz;
  const peers = [peer, ...options.others].toSorted(byName);
  if (new Set(peers).size !== peers.length) {
    throw new Error(
      `Two peers of a session have the same name: ${peers.join(", ")}, with "${peer}" as me. Give this peer's name as me, and each other peer's once in others.`
    );
  }

  // What this peer issued and has not put in a message yet.
  let issued: Issued[] = [];
  const reins = take((name, payload) => {
    issued.push({ name, payload });
  });

  const start = app.time.tick;
  const made: Made = { game, hz, peers, start };
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
  // Per other peer, the first tick it has said it is missing a message for.
  const acked = new Map<string, number>();
  for (const name of peers) {
    if (name !== peer) {
      acked.set(name, start);
    }
  }
  // This peer's messages that some other peer hasn't heard, by tick.
  const kept = new Map<number, Message>();

  // --- time sync: how far ahead of the others this peer runs ----------------
  // Per other peer, the latest tick it said it was at, and how far ahead of
  // the peer furthest behind it it found itself then.
  const clock = new Map<string, number>();
  const told = new Map<string, number>();
  for (const name of acked.keys()) {
    clock.set(name, start);
    told.set(name, 0);
  }
  /**
   * How far ahead of the peer furthest behind this one finds itself, the
   * time a message takes and all. Below 0 when every other is ahead.
   */
  const advantage = (): number =>
    Math.max(...Array.from(clock.values(), (at) => app.time.tick - at));

  /** Returns the first tick this peer is missing another peer's message for. */
  const heard = (): number => {
    let least = Number.POSITIVE_INFINITY;
    for (const [name, next] of have) {
      if (name !== peer) {
        least = Math.min(least, next);
      }
    }
    return least;
  };

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
      const message: Message = {
        from: peer,
        tick,
        actions,
        ...(checkpoints.length === 0 ? {} : { checkpoints }),
        ...(tick === start ? { made } : {}),
        ...(acked.size === 0
          ? {}
          : { heard: heard(), at: now, lead: advantage() }),
      };
      outbox.push(message);
      if (acked.size > 0) {
        kept.set(tick, message);
      }
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
  const run = Effect.fnUntraced(function* (tick: number) {
    let whole = true;
    for (const next of have.values()) {
      whole &&= next > tick;
    }
    if (whole) {
      moments.delete(tick);
    } else {
      // A peer has not said: the tick is run as if it had nothing to say,
      // and the game is kept as it was, to go back to if it had.
      moments.set(tick, yield* Timeline.capture(app));
    }
    // Every peer applies the tick's actions in the same order: peer by
    // peer in order of name, and each peer's in the order it issued them.
    for (const name of peers) {
      for (const action of held.get(name)!.get(tick) ?? []) {
        reins.deliver(action.name, action.payload, name);
      }
    }
    const exit = yield* Effect.exit(reins.tick(delta));
    // The checkpoint the tick recorded, if it did.
    const last = app.actionLog.at(-1);
    if (
      last !== undefined &&
      Action.isCheckpoint(last) &&
      last.tick === app.time.tick
    ) {
      drift.took(last.tick, last.hash);
    }
    return yield* exit;
  });

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

  const ticking: Effect.Effect<
    boolean,
    E | Drift.Unlike | Drift.Drifted | Save.Refused
  > = Effect.gen(function* () {
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
          : yield* app.checkpoint()
      );
    }
    let failed: Exit.Exit<never, E | Save.Refused> | undefined;
    if (wrong !== undefined) {
      // A message came for a tick that had run without it. Back to before
      // that tick, and forward again with what is known now.
      const from = wrong;
      wrong = undefined;
      yield* Timeline.rewind(app, moments.get(from)!, { again: true });
      rewinds++;
      for (let tick = from; tick < now; tick++) {
        const exit = yield* Effect.exit(run(tick));
        resimulated++;
        if (Exit.isFailure(exit)) {
          failed ??= Exit.failCause(exit.cause);
          if (app.time.tick === tick) {
            // The tick did not run at all: it could not be captured.
            return yield* failed;
          }
        }
      }
    }
    compare();
    prune();
    if (drift.drifted !== undefined) {
      return yield* stop(drift.drifted);
    }
    if (failed !== undefined) {
      return yield* failed;
    }
    // The devices next: what they issue goes into this tick's message.
    yield* app.input();
    say(now);
    // No further than `ahead` ticks past what every peer has said.
    if (now - known() >= ahead) {
      return false;
    }
    const exit = yield* Effect.exit(run(now));
    if (Exit.isFailure(exit) && app.time.tick === now) {
      return yield* Exit.failCause(exit.cause);
    }
    // The checkpoint this tick recorded, against what the others said of it.
    compare();
    if (drift.drifted !== undefined && Exit.isSuccess(exit)) {
      return yield* stop(drift.drifted);
    }
    yield* exit;
    return true;
  });

  return {
    app,
    close: app.close,
    me: peer,
    peers,
    hz,
    delay,
    ahead,
    receive(message) {
      if (message.made !== undefined) {
        drift.told(message.from, message.made);
      }
      const at = clock.get(message.from);
      if (message.at !== undefined && at !== undefined && message.at >= at) {
        clock.set(message.from, message.at);
        told.set(message.from, message.lead ?? 0);
      }
      const said = acked.get(message.from);
      if (
        message.heard !== undefined &&
        said !== undefined &&
        message.heard > said
      ) {
        acked.set(message.from, message.heard);
        // What every other peer has heard is no longer kept.
        const everyone = Math.min(...acked.values());
        for (const tick of kept.keys()) {
          if (tick >= everyone) {
            break;
          }
          kept.delete(tick);
        }
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
    resend() {
      // As they were, with how far this peer has heard by now.
      const now = heard();
      return Array.from(kept.values(), (message) => ({
        ...message,
        heard: now,
      }));
    },
    tick: () => ticking,
    get drifted() {
      return drift.drifted;
    },
    get waitingFor() {
      // The tick that has to be whole before the next one may run.
      const needed = app.time.tick - ahead;
      return peers.filter((name) => name !== peer && have.get(name)! <= needed);
    },
    get confirmed() {
      return wrong === undefined
        ? Math.min(known(), app.time.tick)
        : Math.min(known(), wrong);
    },
    get lead() {
      // Against each other peer, half the difference of how far ahead each
      // found itself: the time a message takes is in both, and cancels.
      let most: number | undefined;
      for (const [name, at] of clock) {
        const mine = app.time.tick - at;
        const lead = (mine - told.get(name)!) / 2;
        most = most === undefined ? lead : Math.max(most, lead);
      }
      return most ?? 0;
    },
    stats: {
      get held() {
        let count = 0;
        for (const turns of held.values()) {
          count += turns.size;
        }
        return count;
      },
      get kept() {
        return moments.size;
      },
      get unheard() {
        return kept.size;
      },
      get unanswered() {
        return drift.unanswered;
      },
      get rewinds() {
        return rewinds;
      },
      get resimulated() {
        return resimulated;
      },
    },
    frame: app.frame,
  };
};
