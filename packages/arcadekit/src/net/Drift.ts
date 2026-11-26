/**
 * What a session stops with when its peers no longer play the same game:
 * `Unlike` when they were not made alike, and `Drifted` when their worlds'
 * hashes differ at a tick. A program catches either by its tag.
 *
 *   const online = Effect.flatMap(Session.make(Duel, options), Transport.connect)
 *   Driver.run(online).pipe(
 *     Effect.catchTags({
 *       DriftUnlike: (unlike) => say(unlike.message),
 *       DriftDrifted: (drifted) => say(`Out of sync at tick ${drifted.tick}`),
 *     })
 *   )
 *
 * Before anything else, each peer says in its first message what it was made
 * with, `Message.Made`. A peer that hears another was made otherwise stops
 * with `Unlike`. After that, each peer's log records hash checks, its world's
 * hash at a tick, and the peers send them to each other with the messages
 * they send anyway. Once every peer has sent its hash for a tick and the tick
 * is final, the hashes are compared, and the first tick whose hashes differ
 * stops every peer with `Drifted`.
 */
import { Data } from "effect";

import type { Made } from "./Message.ts";

/**
 * The peers are no longer playing the same game: at one tick, their worlds'
 * hashes differed. Every later tick of the session fails with this error.
 *
 * Drift is found within a bounded number of ticks. A hash check is recorded
 * every `hashEvery` ticks, and travels with the message for the tick
 * `delay` ahead, a message no peer can run that tick without. So no peer runs
 * more than `hashEvery - 1 + delay` ticks past the first tick whose
 * world differed, where `delay` is the largest any peer uses. A session that
 * runs ahead sends a tick's hash only once every peer has sent its actions
 * for that tick, so its bound is `hashEvery - 1 + delay + 2 × ahead`
 * ticks.
 *
 * What is compared is the world's hash, which covers the actions queued for
 * the next tick and the events waiting to be read. A difference it doesn't
 * cover, such as how far a system has read or a system's own variables, is
 * found only once it reaches the world, and the report names that tick.
 *
 * @category Errors
 */
export class Drifted extends Data.TaggedError("DriftDrifted")<{
  /** The tick of the first hash check whose hashes differ. */
  readonly tick: number;
  /** The peer that found it, which is this one. */
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
        ? "No earlier hash check matched, so they did not start from the same state: check that every peer was made with the same seed, and that the plugins' setups spawn the same things on each"
        : `They last agreed at tick ${this.agreedAt}, so they came apart in one of the ${this.tick - this.agreedAt} ticks after it: look for a system or a handler that reads what is not in the world (Math.random, a clock, a service that keeps state of its own, the order of a Map or a Set), or for peers whose systems of the same name do different things`;
    return `The peers are no longer playing the same game. At tick ${this.tick} the hashes of their worlds are: ${hashes} (found by "${this.peer}"). ${since}.`;
  }
}

const list = (names: readonly string[]): string =>
  names.length === 1
    ? names[0]!
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;

/**
 * The peers were not made alike. Another peer's first message says it was
 * made with another game, another `hz`, other names or another start than
 * this one. It is found before either peer runs a tick it is sure of, and
 * every later tick of the session fails with it.
 *
 * @category Errors
 */
export class Unlike extends Data.TaggedError("DriftUnlike")<{
  /** The peer that found it, which is this one. */
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
        case "hz": {
          return `"${peer}" ticks ${mine.hz} times a second and "${other}" ${theirs.hz}. Give every peer the same hz`;
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
