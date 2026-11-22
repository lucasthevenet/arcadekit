/**
 * Peers that are no longer playing the same game, and how they find out.
 */
import { Data } from "effect";

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
        : `They last agreed at tick ${this.agreedAt}, so they came apart in one of the ${this.tick - this.agreedAt} ticks after it: look for a system or a handler that reads what is not in the world (Math.random, a clock, a service that keeps state of its own, the order of a Map or a Set), or for peers that were not made alike (a plugin, the delta)`;
    return `The peers are no longer playing the same game. At tick ${this.tick} the hashes of their worlds are: ${hashes} (found by "${this.peer}"). ${since}.`;
  }
}
