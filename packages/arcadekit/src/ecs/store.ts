/**
 * Stores: state a world holds for someone else, beside its components. An
 * app keeps the events waiting to be read in one, the actions queued for the
 * next tick in another, and its log in a third.
 *
 * A store is the one place that knows how its state is kept. The world knows
 * only that it has stores, and asks each of them the same things: what a
 * snapshot holds of it, what the hash covers, what it is at this moment and
 * how to go back to that, and how to take back what an action's handler did.
 * So state that is added to a game is added in one place, its store, and
 * `snapshot`, `load`, `restore`, `hash`, a capture, a rewind and a transaction
 * cover it without being told.
 *
 * No Effect dependency.
 */

/**
 * State a world holds beside its components, attached with `World._attach`.
 * `M` is what it captures of itself, in memory.
 *
 * @internal
 */
export interface Store<M = unknown> {
  /** Its identity in a world and in a snapshot. Unique among a world's stores. */
  readonly name: string;
  /**
   * Whether the stages between ticks may change it, as they issue the actions
   * for the next tick. `World._frameHash`, which those stages must leave as
   * it was, leaves such a store out. Any other store refuses a change while
   * `world.frozen` is true.
   */
  readonly betweenTicks: boolean;
  /**
   * What a snapshot holds of it, as plain data, or undefined when it holds
   * nothing to save: a store that is empty saves as one that was never
   * attached. Throws a `SnapshotError` whose problem is `"cannot be saved"`
   * when it holds what has no saved form.
   */
  save(): unknown;
  /**
   * Takes what `save` returned, in a store that holds nothing. It trusts
   * nothing of it: what it can't take is a `SnapshotError`.
   */
  load(data: unknown): void;
  /**
   * What `World.hash` covers of it, as plain data, or undefined when it
   * holds nothing a simulation can tell apart: a store that is empty hashes
   * as one that was never attached. It doesn't throw.
   */
  hashed(): unknown;
  /** What it holds now, in memory, for `rewind` to put back. */
  capture(): M;
  /** Puts back what `capture` returned, in a store that holds nothing. */
  rewind(moment: M): void;
  /** Empties it, as it was when it was attached. */
  clear(): void;
  /** A transaction begins: `rollback` takes back what is done from here. */
  begin(): void;
  /** Takes back what was done since `begin`. */
  rollback(): void;
  /** Keeps what was done since `begin`. */
  commit(): void;
  /**
   * What it holds, as plain data to look at, or undefined when it holds
   * nothing: for `World.contents`.
   */
  contents(): unknown;
}

/**
 * Whether a value is plain data that `Store.save` may hold: null, a boolean,
 * a number, a string, or an array or an object that JSON can write. A
 * function, a symbol and a big integer are not.
 *
 * @internal
 */
export const isPlain = (value: unknown): boolean => {
  switch (typeof value) {
    case "function":
    case "symbol":
    case "bigint": {
      return false;
    }
    case "object": {
      if (value === null) {
        return true;
      }
      try {
        return JSON.stringify(value) !== undefined;
      } catch {
        return false;
      }
    }
    default: {
      return true;
    }
  }
};
