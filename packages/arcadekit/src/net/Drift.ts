/**
 * Peers that are no longer playing the same game, and how they find out.
 *
 * Before anything else, each peer says what it was made with, `Message.Made`,
 * in its first message, and a peer that hears another made otherwise stops
 * with `Unlike`. After that, each peer's log records checkpoints, its world's
 * hash at a tick, and the peers send them to each other with the messages
 * they send anyway. A `Comparison` is one peer's side of that: it is told the
 * checkpoints this peer takes and the ones the others sent, says which of its
 * own to send, and compares a tick's once every peer has said and the tick is
 * final. The first tick whose hashes differ is `Drifted`.
 *
 *   const drift = Drift.make({ peer: "ada", made })
 *   drift.told("grace", theirs)                  // what grace was made with
 *   drift.took(0, hash)                          // this peer's, at a tick
 *   drift.heard("grace", 0, [{ tick: 0, hash }]) // with grace's message for tick 0
 *   drift.compare(final, now)                    // Drifted, once they differ
 *
 * It knows no session and no network: `Peer` tells it what is final.
 */
import { Data } from "effect";

import type * as Action from "../Action";
import type { Made } from "./Message";

/**
 * The peers are no longer playing the same game: at one tick, their worlds'
 * hashes differed. Every later tick of the session fails with this error.
 *
 * Drift is detected within a bounded number of ticks. A checkpoint is recorded
 * every `checkpointEvery` ticks and travels with the message for the tick
 * `delay` ahead, which no peer can run without. So no peer runs more than
 * `checkpointEvery - 1 + delay` ticks past the first tick whose world differed,
 * where `delay` is the largest any peer uses. A session that runs ahead
 * sends a tick's hash once every peer has sent their actions for it, so there
 * the bound is `checkpointEvery - 1 + delay + 2 × ahead` ticks.
 *
 * What is compared is the world's hash, which covers the actions queued for
 * the next tick and the events waiting to be read. What it doesn't cover, how
 * far a system has read or a system's own variables, is only detected once it
 * affects the world, and the report names that tick.
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
        ? "No earlier checkpoint matched, so they did not start from the same state: check that every peer was made with the same seed, and that the plugins' setups spawn the same things on each"
        : `They last agreed at tick ${this.agreedAt}, so they came apart in one of the ${this.tick - this.agreedAt} ticks after it: look for a system or a handler that reads what is not in the world (Math.random, a clock, a service that keeps state of its own, the order of a Map or a Set), or for peers whose systems of the same name do different things`;
    return `The peers are no longer playing the same game. At tick ${this.tick} the hashes of their worlds are: ${hashes} (found by "${this.peer}"). ${since}.`;
  }
}

const parts: readonly (keyof Made)[] = ["game", "delta", "peers", "start"];

/** Returns the parts in which two peers were made differently. */
const differences = (one: Made, other: Made): (keyof Made)[] =>
  parts.filter((part) =>
    part === "peers"
      ? one.peers.length !== other.peers.length ||
        one.peers.some((name, at) => name !== other.peers[at])
      : one[part] !== other[part]
  );

const list = (names: readonly string[]): string =>
  names.length === 1
    ? names[0]!
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;

/**
 * The peers were not made alike: another peer's first message says it was
 * made with another game, another `delta`, other names or another start than
 * this one. It is found before either runs a tick it is sure of, and every
 * later tick of the session fails with it.
 *
 * @category Errors
 */
export class Unlike extends Data.TaggedError("Unlike")<{
  /** The peer that found it: this one. */
  readonly peer: string;
  /** The peer whose first message said otherwise. */
  readonly other: string;
  /** What this peer was made with. */
  readonly mine: Made;
  /** What the other peer was made with. */
  readonly theirs: Made;
  /** What the two were made with differently, one or more of these. */
  readonly differ: readonly (keyof Made)[];
}> {
  override get message(): string {
    const { mine, other, peer, theirs } = this;
    const said = this.differ.map((part) => {
      switch (part) {
        case "game": {
          return "they play another game: a system of the tick, a hook of a state or a handler that one has and the other hasn't, systems that run in another order, or another version. Give every peer the same App.define";
        }
        case "delta": {
          return `"${peer}" ticks ${mine.delta} seconds at a time and "${other}" ${theirs.delta}. Give every peer the same delta`;
        }
        case "peers": {
          return `"${peer}" plays with ${list(mine.peers)}, and "${other}" with ${list(theirs.peers)}. Give every peer the same names`;
        }
        case "start": {
          return `"${peer}" begins at tick ${mine.start} and "${other}" at tick ${theirs.start}. Give every peer the same seed or save`;
        }
      }
    });
    return `The peers "${peer}" and "${other}" were not made alike: ${said.join("; ")}.`;
  }
}

/** How many ticks an unanswered checkpoint is kept. */
const UNANSWERED = 600;

/**
 * One peer's comparison of its checkpoints with the other peers', from
 * `Drift.make`.
 *
 * @category Models
 */
export interface Comparison {
  /**
   * What another peer says it was made with. A peer made otherwise than this
   * one stops the comparison with `Unlike`, whoever it is, since a name that
   * isn't a peer of this game is one this peer was made without.
   */
  readonly told: (from: string, made: Made) => void;
  /**
   * This peer's own hash at a tick, as its log recorded it. It is neither
   * sent nor compared until the tick is final. A tick that is run again
   * says again, and the last hash said is the one kept.
   */
  readonly took: (tick: number, hash: number) => void;
  /**
   * The checkpoints a peer's message carried: `sent` is the tick the
   * message is for. A peer's checkpoints are taken in the order it sent
   * them, whatever order its messages arrive in, so that the last tick the
   * peers agreed at is known when the next one differs.
   */
  readonly heard: (
    from: string,
    sent: number,
    checkpoints: readonly Action.Checkpoint[]
  ) => void;
  /**
   * Makes this peer's hashes final up to the tick `final`, and compares
   * every checkpoint up to it that this peer and all the others have. `now`
   * is the tick the game is at: a checkpoint no peer has answered in 600
   * ticks is let go of. Returns why the peers have drifted, once they have,
   * and from then on compares nothing.
   */
  readonly compare: (
    final: number,
    now: number
  ) => Drifted | Unlike | undefined;
  /**
   * This peer's final checkpoints that it has not sent yet, for its next
   * message, and forgets them: the next call returns only newer ones.
   */
  readonly unsent: () => readonly Action.Checkpoint[];
  /**
   * Why the peers have drifted, once `compare` has found that they have, or
   * why they were never alike, once `told` has.
   */
  readonly drifted: Drifted | Unlike | undefined;
  /** How many of this peer's final checkpoints are waiting for a peer's hash. */
  readonly unanswered: number;
}

/**
 * Makes one peer's comparison: `peer` is this peer and `made` what it was
 * made with, among it every peer of the game and the tick the game begins
 * at, which is the tick of every peer's first message.
 *
 * @category Constructors
 */
export const make = (options: {
  readonly peer: string;
  readonly made: Made;
}): Comparison => {
  const { made, peer } = options;
  const { peers, start } = made;
  // The hashes this peer's log recorded at ticks that are not final yet.
  const taken = new Map<number, number>();
  // This peer's final hashes, by tick, until every peer has answered them.
  const mine = new Map<number, number>();
  // The other peers' hashes, by tick and then by name.
  const theirs = new Map<number, Map<string, number>>();
  // Per peer, the checkpoints of messages that came ahead of an earlier
  // one, and the tick of the next message to take checkpoints from.
  const early = new Map<string, Map<number, readonly Action.Checkpoint[]>>();
  const next = new Map<string, number>();
  for (const name of peers) {
    early.set(name, new Map());
    next.set(name, start);
  }
  let unsent: Action.Checkpoint[] = [];
  let drifted: Drifted | Unlike | undefined;
  let agreedAt: number | undefined;

  return {
    told(from, theirs) {
      if (
        drifted === undefined &&
        from !== peer &&
        differences(made, theirs).length > 0
      ) {
        drifted = new Unlike({
          peer,
          other: from,
          mine: made,
          theirs,
          differ: differences(made, theirs),
        });
      }
    },
    took(tick, hash) {
      taken.set(tick, hash);
    },
    heard(from, sent, checkpoints) {
      const waiting = early.get(from);
      if (waiting === undefined) {
        // Not a peer of the game.
        return;
      }
      waiting.set(sent, checkpoints);
      let expected = next.get(from)!;
      for (
        let due = waiting.get(expected);
        due !== undefined;
        due = waiting.get(expected)
      ) {
        waiting.delete(expected++);
        for (const { hash, tick } of due) {
          let said = theirs.get(tick);
          if (said === undefined) {
            said = new Map();
            theirs.set(tick, said);
          }
          said.set(from, hash);
        }
      }
      next.set(from, expected);
    },
    compare(final, now) {
      if (drifted !== undefined) {
        return drifted;
      }
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
        if (tick >= now - UNANSWERED) {
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
          return drifted;
        }
        agreedAt = tick;
      }
      return undefined;
    },
    unsent() {
      const checkpoints = unsent;
      unsent = [];
      return checkpoints;
    },
    get drifted() {
      return drifted;
    },
    get unanswered() {
      return mine.size;
    },
  };
};
