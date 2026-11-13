/**
 * Ring readers: how far one view has read one ring (ADR-0023).
 *
 * A view keeps one reader for each ring it reads, and two views read one ring with a reader
 * each. A reader writes nothing to the ring, so a view still never changes a run's state.
 *
 * @since 0.7.0
 */
import type { Types } from "effect";
import { Inspectable, Pipeable, Predicate } from "effect";
import { dual } from "effect/Function";

import type * as Layout from "./layout";
import type * as Ring from "./ring";

const TypeId = "~arcadekit/core/RingReader";

/**
 * How far one view has read one ring: the number of the first record it has not taken.
 *
 * **When to use**
 *
 * Keep one in a view for each ring of what a step did that the view shows, and take what is new
 * on each frame.
 *
 * **Details**
 *
 * It follows a ring whose `written` only grows, as that of a ring only views read does. A ring
 * the rules pop or clear is not followed: a reader is told of neither, and misses records pushed
 * after one.
 *
 * **Example** (Taking what a step pushed since the last frame)
 *
 * ```ts
 * import { Ring, RingReader } from "arcadekit/core";
 *
 * const hits = Ring.make(8, { amount: Uint16Array });
 * const seen = RingReader.make();
 * RingReader.take(seen, hits);
 *
 * for (const amount of [5, 7]) {
 *   hits.fields.amount[Ring.push(hits)] = amount;
 * }
 * const shown: number[] = [];
 * for (let n = RingReader.take(seen, hits); n < hits.written; n++) {
 *   shown.push(hits.fields.amount[Ring.slotOf(hits, n)]!);
 * }
 * shown; // => [5, 7]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface RingReader extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
}

/** What a reader is handed: a ring's two counts, which are all it reads. */
type Counted = Pick<Ring.Ring<Layout.Layout>, "capacity" | "written">;

/** What the module's functions keep, which no caller reads. */
type Internal = Types.Mutable<RingReader> & {
  /** The ring last taken from: a new run's ring is another object, and starts the reader again. */
  ring: Counted | null;
  /** The number of the first record not taken yet. */
  next: number;
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Internal) {
    return { _id: "RingReader", next: this.ring === null ? null : this.next };
  },
};

/**
 * Checks whether a value is a ring reader.
 *
 * **When to use**
 *
 * Narrow an unknown value before taking from a ring with it.
 *
 * **Example** (Recognising a reader)
 *
 * ```ts
 * import { RingReader } from "arcadekit/core";
 *
 * RingReader.isRingReader(RingReader.make()); // => true
 * RingReader.isRingReader({ next: 0 }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isRingReader = (value: unknown): value is RingReader =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a reader that has read no ring yet.
 *
 * **When to use**
 *
 * Once per view and ring, when the view is made.
 *
 * **Details**
 *
 * Its first take of a ring starts at what the ring has written then: a view shows what happens
 * from now on.
 *
 * **Example** (Making a reader for each view)
 *
 * ```ts
 * import { Ring, RingReader } from "arcadekit/core";
 *
 * const hits = Ring.make(8, { amount: Uint16Array });
 * Ring.push(hits);
 * const drawing = RingReader.make();
 * const sound = RingReader.make();
 * RingReader.take(drawing, hits); // => 1
 * RingReader.take(sound, hits); // => 1
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (): RingReader => {
  const self = Object.create(Proto) as Internal;
  self.ring = null;
  self.next = 0;
  return self;
};

/**
 * The number of the first record this reader has not taken from `ring`, and takes every record
 * up to `ring.written`. Read the records `[take(self, ring), ring.written)`.
 *
 * **When to use**
 *
 * Once per frame in a view, before it reads the records a step pushed since its last frame.
 *
 * **Details**
 *
 * The first take of a ring gives `ring.written`: a view shows what happens from now on, not
 * what happened before it looked. After that it gives where it stopped, or
 * `ring.written - ring.capacity` if the ring has lapped it. A new run's ring is another object,
 * and the reader starts again on it at its `written`.
 *
 * If it finds `written` below what it took, the ring was popped or cleared, and it starts again
 * at `written`. That is all it can see of either: once `written` is back at what it took, or
 * past it, it takes the records from there as if none had been forgotten. It reads only the
 * ring's two counts, so anything with them is a ring to it.
 *
 * **Example** (Losing the oldest once lapped)
 *
 * ```ts
 * import { Ring, RingReader } from "arcadekit/core";
 *
 * const ring = Ring.make(4, { x: Float32Array });
 * const reader = RingReader.make();
 * Ring.push(ring);
 * RingReader.take(reader, ring); // => 1
 *
 * for (let i = 0; i < 6; i++) {
 *   Ring.push(ring);
 * }
 * RingReader.take(reader, ring); // => 3
 * RingReader.take(reader, ring); // => 7
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const take: {
  (ring: Counted): (self: RingReader) => number;
  (self: RingReader, ring: Counted): number;
} = dual(2, (self: RingReader, ring: Counted): number => {
  const reader = self as Internal;
  const { written } = ring;
  let from = reader.next;
  if (reader.ring !== ring || written < from) {
    reader.ring = ring;
    from = written;
  } else if (written - from > ring.capacity) {
    // Lapped: the records before this one were overwritten.
    from = written - ring.capacity;
  }
  reader.next = written;
  return from;
});

/**
 * Forgets the ring, so the next take starts at its `written`.
 *
 * **When to use**
 *
 * When a view skips what happened while it wasn't looking, such as after it was hidden.
 *
 * **Example** (Starting again)
 *
 * ```ts
 * import { Ring, RingReader } from "arcadekit/core";
 *
 * const ring = Ring.make(4, { x: Float32Array });
 * const reader = RingReader.make();
 * RingReader.take(reader, ring);
 * Ring.push(ring);
 * Ring.push(ring);
 * RingReader.reset(reader);
 * RingReader.take(reader, ring); // => 2
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const reset = (self: RingReader): void => {
  (self as Internal).ring = null;
};
