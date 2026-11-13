import type { Pool, PoolLayout } from "./pool";

// A state hash: a 32-bit digest of the numbers a game lists from a run's state, in a fixed
// order. The game keeps the list and the kit folds it, so the kit never looks inside a state
// (ADR-0007), and what only a view reads is left out by not being listed (ADR-0014). A host or a
// test takes a hash between steps: the rules never read one.

const OFFSET_BASIS = 0x81_1c_9d_c5;
const PRIME = 0x01_00_01_93;
/** The bytes of a float64. */
const BYTES = 8;
/** The eight bytes every NaN is folded as: those of 0x7ff8000000000000, lowest first. */
const NAN_BYTES = Uint8Array.of(0, 0, 0, 0, 0, 0, 0xf8, 0x7f);

/**
 * FNV-1a, 32 bits, over each number's eight bytes as a float64: a change in any bit shows.
 * Every NaN is folded as the same eight bytes: a NaN has many bit patterns, and no rule can tell
 * one from another.
 */
export class StateHasher {
  /** Folds one number in. A function of its own, so a list takes it as its `add`. */
  readonly number: (value: number) => StateHasher;
  private hash = OFFSET_BASIS;

  constructor() {
    // Made once, so folding a number in allocates nothing.
    const bits = new Float64Array(1);
    const bytes = new Uint8Array(bits.buffer);
    this.number = (value) => {
      if (Number.isNaN(value)) {
        // An engine may store a NaN with any of its bit patterns, and V8's depends on how the NaN
        // was made. Read back, they would give two equal states two digests.
        bytes.set(NAN_BYTES);
      } else {
        bits[0] = value;
      }
      // By index: a `for…of` makes an iterator, and a result for each byte, until an engine's
      // optimiser takes them out.
      for (let i = 0; i < BYTES; i++) {
        this.hash = Math.imul(this.hash ^ bytes[i]!, PRIME) >>> 0;
      }
      return this;
    };
  }

  /** The digest of what was folded in since the last `reset`: an unsigned 32-bit integer. */
  digest(): number {
    return this.hash;
  }

  /** Starts again from FNV-1a's offset basis. */
  reset(): StateHasher {
    this.hash = OFFSET_BASIS;
    return this;
  }
}

/**
 * Calls `visit` with the pool's `count`, then with each field's live values, one field at a
 * time in the layout's order. It allocates nothing.
 *
 * A field named by a whole number (`{ 0: Uint8Array }`) is the exception to both: such fields
 * come first, in ascending order, as an object's keys do, and an engine may list them afresh on
 * every call.
 *
 * An identified pool's ids are not visited: they follow from the order of its adds and removes.
 */
export const visitPool = <L extends PoolLayout>(
  pool: Pool<L>,
  visit: (value: number) => void
): void => {
  visit(pool.count);
  const { fields } = pool;
  // The fields `Object.values` would list, in its order, without the array it would make on
  // every call.
  for (const name in fields) {
    if (Object.hasOwn(fields, name)) {
      const array = fields[name];
      for (let i = 0; i < pool.count; i++) {
        visit(array[i]!);
      }
    }
  }
};
