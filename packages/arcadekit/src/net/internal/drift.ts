import type * as Action from "../../Action.ts";
import { Drifted, Unlike } from "../Drift.ts";
import type { Made } from "../Message.ts";

const parts: readonly (keyof Made)[] = ["game", "hz", "peers", "start"];

/** Returns the parts in which two peers were made differently. */
const differences = (one: Made, other: Made): (keyof Made)[] =>
  parts.filter((part) =>
    part === "peers"
      ? one.peers.length !== other.peers.length ||
        one.peers.some((name, at) => name !== other.peers[at])
      : one[part] !== other[part]
  );

/** How many ticks an unanswered hash check is kept. */
const UNANSWERED = 600;

/**
 * One peer's side of finding drift. It is told the hash checks this peer
 * takes and the ones the others sent, says which of its own to send, and
 * compares the hashes of a tick once every peer has sent its own and the
 * session says the tick is final.
 *
 * @internal
 */
export interface Comparison {
  /**
   * Tells it what another peer says it was made with. A peer made otherwise
   * than this one stops the comparison with `Unlike`, even one that isn't a
   * peer of this game, since this peer was made without its name.
   */
  readonly told: (from: string, made: Made) => void;
  /**
   * Tells it this peer's own hash at a tick, as its log recorded it. The hash
   * is neither sent nor compared until the tick is final. A tick that runs
   * again is told again, and the last hash told is kept.
   */
  readonly took: (tick: number, hash: number) => void;
  /**
   * Tells it the hash checks a peer's message carried, where `sent` is the
   * tick the message is for. It takes a peer's hash checks in the order the
   * peer sent them, whatever order its messages arrive in, so the last tick
   * the peers agreed at is known when the next one differs.
   */
  readonly heard: (
    from: string,
    sent: number,
    hashChecks: readonly Action.HashCheck[]
  ) => void;
  /**
   * Makes this peer's hashes final up to the tick `final`, and compares
   * every hash check up to it that this peer and all the others have. `now`
   * is the tick the game is at, and a hash check no peer has answered in 600
   * ticks is dropped. Returns `Drifted` or `Unlike` once the peers have
   * drifted or were found unlike, and compares nothing from then on.
   */
  readonly compare: (
    final: number,
    now: number
  ) => Drifted | Unlike | undefined;
  /**
   * Returns this peer's final hash checks that it hasn't sent yet, for its
   * next message, and forgets them. The next call returns only newer ones.
   */
  readonly unsent: () => readonly Action.HashCheck[];
  /**
   * Why the peers have drifted, once `compare` has found that they have, or
   * why they were never alike, once `told` has.
   */
  readonly drifted: Drifted | Unlike | undefined;
  /** How many of this peer's final hash checks are waiting for a peer's hash. */
  readonly unanswered: number;
}

/**
 * Makes one peer's comparison. `peer` is this peer's name, and `made` is what
 * it was made with, which names every peer of the game and the tick the game
 * begins at. That tick is the tick of every peer's first message.
 *
 * @internal
 */
export const makeComparison = (options: {
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
  // Per peer, the hash checks of messages that came ahead of an earlier
  // one, and the tick of the next message to take hash checks from.
  const early = new Map<string, Map<number, readonly Action.HashCheck[]>>();
  const next = new Map<string, number>();
  for (const name of peers) {
    early.set(name, new Map());
    next.set(name, start);
  }
  let unsent: Action.HashCheck[] = [];
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
    heard(from, sent, hashChecks) {
      const waiting = early.get(from);
      if (waiting === undefined) {
        // Not a peer of the game.
        return;
      }
      waiting.set(sent, hashChecks);
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
          // Nothing to hold it against: a hash check the other peer took by
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
      const hashChecks = unsent;
      unsent = [];
      return hashChecks;
    },
    get drifted() {
      return drifted;
    },
    get unanswered() {
      return mine.size;
    },
  };
};
