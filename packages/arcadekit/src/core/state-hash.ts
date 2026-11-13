/**
 * State hashes: a 32-bit digest of the numbers a game lists from a run's state, in a fixed
 * order.
 *
 * The game keeps the list and the kit folds it, so the kit never looks inside a state (ADR-0007),
 * and what only a view reads is left out by not being listed (ADR-0014). A host or a test takes
 * a hash between steps, and lockstep peers compare theirs to find a desync: the rules never read
 * one.
 *
 * @since 0.7.0
 */
import type { Types } from "effect";
import { Inspectable, Pipeable, Predicate } from "effect";
import { dual } from "effect/Function";

const TypeId = "~arcadekit/core/StateHash";

const OFFSET_BASIS = 0x81_1c_9d_c5;
const PRIME = 0x01_00_01_93;
/** The bytes of a float64. */
const BYTES = 8;
/** The eight bytes every NaN is folded as: those of 0x7ff8000000000000, lowest first. */
const NAN_BYTES = Uint8Array.of(0, 0, 0, 0, 0, 0, 0xf8, 0x7f);

/**
 * A state hash being folded: FNV-1a, 32 bits, over each number's eight bytes as a float64, so a
 * change in any bit shows.
 *
 * **When to use**
 *
 * Make one for a game's state hash, and fold in the numbers its list names, in order, each time
 * it hashes. A replay test pins the digest; lockstep peers compare it.
 *
 * **Details**
 *
 * Every NaN is folded as the same eight bytes: a NaN has many bit patterns, an engine may store
 * one with any of them, and no rule can tell one from another. Folding a number in allocates
 * nothing.
 *
 * **Example** (Hashing a few numbers of a state)
 *
 * ```ts
 * import { StateHash } from "arcadekit/core";
 *
 * const hash = StateHash.make();
 * StateHash.add(hash, 1);
 * StateHash.add(hash, 2);
 * StateHash.digest(hash); // => 1170904120
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface StateHash extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
}

/** What the module's functions keep, which no caller reads. */
type Internal = Types.Mutable<StateHash> & {
  /** The digest so far. */
  hash: number;
  /** One float64, made once, whose bytes `add` reads. */
  bits: Float64Array;
  bytes: Uint8Array;
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Internal) {
    return { _id: "StateHash", digest: this.hash };
  },
};

/**
 * Checks whether a value is a state hash.
 *
 * **When to use**
 *
 * Narrow an unknown value before folding into it.
 *
 * **Example** (Recognising a state hash)
 *
 * ```ts
 * import { StateHash } from "arcadekit/core";
 *
 * StateHash.isStateHash(StateHash.make()); // => true
 * StateHash.isStateHash(2166136261); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isStateHash = (value: unknown): value is StateHash =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a state hash with nothing folded in: its digest is FNV-1a's offset basis.
 *
 * **When to use**
 *
 * Once for a game's hash function, kept beside it, and reset at the start of each hash.
 *
 * **Example** (Making a state hash)
 *
 * ```ts
 * import { StateHash } from "arcadekit/core";
 *
 * StateHash.digest(StateHash.make()); // => 2166136261
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (): StateHash => {
  const self = Object.create(Proto) as Internal;
  self.hash = OFFSET_BASIS;
  // Made once, so folding a number in allocates nothing.
  self.bits = new Float64Array(1);
  self.bytes = new Uint8Array(self.bits.buffer);
  return self;
};

/**
 * Folds one number in, and returns the same state hash.
 *
 * **When to use**
 *
 * For each number of the game's list, in the list's order. A game's list that takes an `add`
 * function is given `(value) => StateHash.add(hash, value)`, made once.
 *
 * **Details**
 *
 * The number's eight bytes as a float64 are folded lowest first, so 0 and -0 fold differently,
 * and every NaN folds alike.
 *
 * **Example** (Folding through a game's list)
 *
 * ```ts
 * import { StateHash } from "arcadekit/core";
 *
 * const hash = StateHash.make();
 * const visitState = (add: (value: number) => void) => {
 *   add(1);
 *   add(2);
 * };
 * visitState((value) => StateHash.add(hash, value));
 * StateHash.digest(hash); // => 1170904120
 *
 * const piped = StateHash.make().pipe(StateHash.add(1), StateHash.add(2));
 * StateHash.digest(piped); // => 1170904120
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const add: {
  (value: number): (self: StateHash) => StateHash;
  (self: StateHash, value: number): StateHash;
} = dual(2, (self: StateHash, value: number): StateHash => {
  const hash = self as Internal;
  const { bits, bytes } = hash;
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
    hash.hash = Math.imul(hash.hash ^ bytes[i]!, PRIME) >>> 0;
  }
  return self;
});

/**
 * The digest of what was folded in since the last reset: an unsigned 32-bit integer.
 *
 * **When to use**
 *
 * Once the game's list is folded in, as the state hash a test pins or a peer compares.
 *
 * **Example** (Reading the digest)
 *
 * ```ts
 * import { StateHash } from "arcadekit/core";
 *
 * const hash = StateHash.make();
 * StateHash.digest(StateHash.add(hash, 0)); // => 2615243109
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const digest = (self: StateHash): number => (self as Internal).hash;

/**
 * Starts again from FNV-1a's offset basis, and returns the same state hash.
 *
 * **When to use**
 *
 * At the start of each hash, so a hash function that keeps one state hash gives the same digest
 * for the same state.
 *
 * **Example** (Hashing the same numbers twice)
 *
 * ```ts
 * import { StateHash } from "arcadekit/core";
 *
 * const hash = StateHash.make();
 * const first = StateHash.digest(StateHash.add(hash, 3));
 * StateHash.reset(hash);
 * StateHash.digest(StateHash.add(hash, 3)) === first; // => true
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const reset = (self: StateHash): StateHash => {
  (self as Internal).hash = OFFSET_BASIS;
  return self;
};
