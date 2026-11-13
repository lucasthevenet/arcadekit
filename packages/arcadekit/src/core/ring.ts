import type { PoolFields, PoolLayout } from "./pool";

// A ring of records, and the reader a view keeps on one (ADR-0023). A ring is one of two things,
// and the game says which by where it keeps it and what its rules do with it:
//
// - A ring only views read carries what a step did: a hit and where it landed, a hole that was
//   filled. The step pushes and never reads it back, so it cannot change what a run does, and
//   its `written` only grows. The game's state hash leaves it out, as it leaves out its cue
//   counters (ADR-0014). It is lossy: a view that looks after more than `capacity` pushes has
//   missed the oldest.
// - A ring the rules pop or read is state, like any other field: an undo history. A state hash
//   covers it, and no reader follows it.

/** A field's array, whichever typed array its layout names. */
type FieldArray = InstanceType<PoolLayout[string]>;

/**
 * A fixed number of records stored as one typed array per field, as a pool's entities are.
 * Record n, counted from 0, is in slot `n % capacity`: a new record overwrites the oldest.
 *
 * Nothing is allocated after creation, so a step that pushes a record allocates nothing.
 */
export interface Ring<L extends PoolLayout> {
  readonly capacity: number;
  /** Records pushed and not popped. */
  readonly written: number;
  /** Records still held, the newest ones: a `push` raises it up to `capacity`, a `pop` lowers it. */
  readonly length: number;
  readonly fields: PoolFields<L>;
  /** Reserves the slot of record `written` and returns it. Every field of the slot is 0. */
  readonly push: () => number;
  /** Forgets the newest record and returns its slot, or -1 when `length` is 0. */
  readonly pop: () => number;
  /** The slot of record `n`. */
  readonly slotOf: (n: number) => number;
  /** Forgets every record: `written` and `length` are 0 again. No reader of the ring is told. */
  readonly clear: () => void;
}

/**
 * Makes a ring of `capacity` records with one typed array for each field of `layout`.
 *
 * Throws a `RangeError` for a capacity that is not a whole number of 1 or more.
 */
export const createRing = <const L extends PoolLayout>(
  capacity: number,
  layout: L
): Ring<L> => {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(
      `createRing needs a whole capacity of 1 or more, got ${capacity}`
    );
  }
  const fields = Object.fromEntries(
    Object.entries(layout).map(([name, ArrayType]) => [
      name,
      new ArrayType(capacity),
    ])
  ) as unknown as PoolFields<L>;
  const arrays = Object.values(fields) as FieldArray[];
  let written = 0;
  let length = 0;
  return {
    capacity,
    get written() {
      return written;
    },
    get length() {
      return length;
    },
    fields,
    push: () => {
      const slot = written % capacity;
      // The slot may hold the record it overwrites, or one that was popped.
      for (const array of arrays) {
        array[slot] = 0;
      }
      written += 1;
      if (length < capacity) {
        length += 1;
      }
      return slot;
    },
    pop: () => {
      if (length === 0) {
        return -1;
      }
      written -= 1;
      length -= 1;
      return written % capacity;
    },
    slotOf: (n) => n % capacity,
    clear: () => {
      written = 0;
      length = 0;
    },
  };
};

/**
 * How far one view has read one ring. A view keeps one reader for each ring it reads, and two
 * views read one ring with a reader each. A reader writes nothing to the ring: a view never
 * changes a run's state.
 *
 * It follows a ring whose `written` only grows, as that of a ring only views read does. A ring
 * the rules pop or clear is not followed: a reader is told of neither, and misses records
 * pushed after one.
 *
 * ```ts
 * const { changes } = puzzle;
 * for (let n = this.seen.take(changes); n < changes.written; n++) {
 *   const i = changes.slotOf(n);
 *   this.sinkBox(changes.fields.box[i]!, changes.fields.cell[i]!, t);
 * }
 * ```
 */
export class RingReader {
  /** The ring last taken from: a new run's ring is another object, and starts the reader again. */
  private ring: Pick<Ring<PoolLayout>, "capacity" | "written"> | null = null;
  /** The number of the first record not taken yet. */
  private next = 0;

  /**
   * The number of the first record this reader has not taken, and takes every record up to
   * `ring.written`. Read records `[take(ring), ring.written)`.
   *
   * The first `take` of a ring gives `ring.written`: a view shows what happens from now on, not
   * what happened before it looked. After that it gives where it stopped, or
   * `ring.written - ring.capacity` if the ring has lapped it.
   *
   * If it finds `written` below what it took, the ring was popped or cleared, and it starts
   * again at `written`. That is all it can see of either: once `written` is back at what it
   * took, or past it, it takes the records from there as if none had been forgotten.
   */
  take(ring: Pick<Ring<PoolLayout>, "capacity" | "written">): number {
    const { written } = ring;
    let from = this.next;
    if (this.ring !== ring || written < from) {
      this.ring = ring;
      from = written;
    } else if (written - from > ring.capacity) {
      // Lapped: the records before this one were overwritten.
      from = written - ring.capacity;
    }
    this.next = written;
    return from;
  }

  /** Forgets the ring, so the next `take` starts at its `written`. */
  reset(): void {
    this.ring = null;
  }
}
