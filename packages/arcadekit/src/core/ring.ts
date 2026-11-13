/**
 * Rings of records: a fixed number of records stored as one typed array per field, where a new
 * record overwrites the oldest (ADR-0023).
 *
 * A ring is one of two things, and the game says which by where it keeps it and what its rules
 * do with it. A ring only views read carries what a step did: a hit and where it landed, a hole
 * that was filled. The step pushes and never reads it back, so it can't change what a run does,
 * its `written` only grows, and the game's state hash leaves it out, as it leaves out its cue
 * counters. It is lossy: a view that looks after more than `capacity` pushes has missed the
 * oldest. A ring the rules pop or read is state, like any other field: an undo history. A state
 * hash covers it, and no ring reader follows it.
 *
 * @since 0.7.0
 */
import type { Types } from "effect";
import { Inspectable, Pipeable, Predicate } from "effect";
import { dual } from "effect/Function";

import { allocate, arraysOf } from "./internal/fields";
import type { FieldArray } from "./internal/fields";
import type * as Layout from "./layout";

const TypeId = "~arcadekit/core/Ring";

/**
 * A fixed number of records stored as one typed array per field, as an entity pool's entities
 * are. Record n, counted from 0, is in slot `n % capacity`: a new record overwrites the oldest.
 *
 * **When to use**
 *
 * Keep one for what a step did that its views must show and the state no longer says, such as a
 * hit, a box that fell in a hole or an undo; or for a bounded history the rules pop, such as an
 * undo's turns.
 *
 * **Details**
 *
 * Nothing is allocated after the ring is made, so a step that pushes a record allocates
 * nothing. `written` counts the records pushed and not popped, and `length` those still held,
 * the newest ones. Each view takes what is new with a `RingReader` of its own.
 *
 * **Example** (Pushing records and reading the newest)
 *
 * ```ts
 * import { Ring } from "arcadekit/core";
 *
 * const hits = Ring.make(2, { x: Float32Array, amount: Uint16Array });
 * for (const amount of [10, 20, 30]) {
 *   hits.fields.amount[Ring.push(hits)] = amount;
 * }
 * [hits.written, hits.length]; // => [3, 2]
 * hits.fields.amount[Ring.slotOf(hits, 2)]; // => 30
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Ring<L extends Layout.Layout>
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** The most records it holds, and the length of every field. */
  readonly capacity: number;
  /** Records pushed and not popped. */
  readonly written: number;
  /** Records still held, the newest ones: a push raises it up to `capacity`, a pop lowers it. */
  readonly length: number;
  /** One typed array per field of the layout, under the layout's names. */
  readonly fields: Layout.Fields<L>;
}

/** What the module's functions write, beyond what a caller reads. */
type Internal<L extends Layout.Layout> = Types.Mutable<Ring<L>> & {
  arrays: readonly FieldArray[];
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Ring<Layout.Layout>) {
    return {
      _id: "Ring",
      capacity: this.capacity,
      written: this.written,
      length: this.length,
      fields: Object.keys(this.fields),
    };
  },
};

/**
 * Checks whether a value is a ring.
 *
 * **When to use**
 *
 * Narrow an unknown value before reading it as a ring.
 *
 * **Details**
 *
 * It looks for the ring's marker, and checks nothing of its layout.
 *
 * **Example** (Recognising a ring)
 *
 * ```ts
 * import { Ring } from "arcadekit/core";
 *
 * Ring.isRing(Ring.make(4, { x: Float32Array })); // => true
 * Ring.isRing({ capacity: 4, written: 0 }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isRing = (value: unknown): value is Ring<Layout.Layout> =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a ring of `capacity` records, with one typed array of that length for each field of
 * `layout`.
 *
 * **When to use**
 *
 * Make each of a run's rings once, when its state is made. Size a ring only views read for what
 * the steps push between two frames.
 *
 * **Details**
 *
 * The ring starts with no record. It throws a `RangeError` for a capacity that is not a whole
 * number of 1 or more.
 *
 * **Example** (Making a ring)
 *
 * ```ts
 * import { Ring } from "arcadekit/core";
 *
 * const changes = Ring.make(8, { box: Int16Array, cell: Int32Array });
 * [changes.capacity, changes.written, changes.length]; // => [8, 0, 0]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = <const L extends Layout.Layout>(
  capacity: number,
  layout: L
): Ring<L> => {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(
      `Ring.make needs a whole capacity of 1 or more, got ${capacity}`
    );
  }
  const self = Object.create(Proto) as Internal<L>;
  self.capacity = capacity;
  self.written = 0;
  self.length = 0;
  self.fields = allocate(layout, capacity);
  self.arrays = arraysOf(self.fields);
  return self;
};

/**
 * Reserves the slot of record `written` and returns it. Every field of the slot is 0.
 *
 * **When to use**
 *
 * In a step, to record what it did: push, then write the record's fields at the slot.
 *
 * **Details**
 *
 * Once the ring holds `capacity` records, the slot is the oldest record's, which is lost. The
 * slot may also hold a record that was popped: either way it is cleaned here.
 *
 * **Example** (Recording a hit)
 *
 * ```ts
 * import { Ring } from "arcadekit/core";
 *
 * const hits = Ring.make(3, { x: Float32Array });
 * const slot = Ring.push(hits);
 * hits.fields.x[slot] = 4.5;
 * slot; // => 0
 * Ring.push(hits); // => 1
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const push = <L extends Layout.Layout>(self: Ring<L>): number => {
  const ring = self as Internal<L>;
  const slot = ring.written % ring.capacity;
  for (const array of ring.arrays) {
    array[slot] = 0;
  }
  ring.written += 1;
  if (ring.length < ring.capacity) {
    ring.length += 1;
  }
  return slot;
};

/**
 * Forgets the newest record and returns its slot, or -1 when `length` is 0.
 *
 * **When to use**
 *
 * In the rules, to take back the last record of a ring that is state, such as an undo popping
 * the turn it undoes.
 *
 * **Details**
 *
 * The record is still in its slot to read until the next push cleans it. A ring a reader follows
 * is not popped: a reader sees only that `written` went down.
 *
 * **Example** (Undoing the last turn)
 *
 * ```ts
 * import { Ring } from "arcadekit/core";
 *
 * const turns = Ring.make(4, { from: Int32Array });
 * turns.fields.from[Ring.push(turns)] = 12;
 * turns.fields.from[Ring.push(turns)] = 13;
 * const slot = Ring.pop(turns);
 * turns.fields.from[slot]; // => 13
 * [turns.written, turns.length]; // => [1, 1]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const pop = <L extends Layout.Layout>(self: Ring<L>): number => {
  const ring = self as Internal<L>;
  if (ring.length === 0) {
    return -1;
  }
  ring.written -= 1;
  ring.length -= 1;
  return ring.written % ring.capacity;
};

/**
 * The slot of record `n`: `n % capacity`.
 *
 * **When to use**
 *
 * To read record `n`, such as each of those a ring reader took.
 *
 * **Details**
 *
 * It says where the record is, not whether it is still held: one more than `capacity` pushes
 * old has been overwritten.
 *
 * **Example** (Reading a record by its number)
 *
 * ```ts
 * import { Ring } from "arcadekit/core";
 *
 * const ring = Ring.make(3, { x: Float32Array });
 * for (let n = 0; n < 5; n++) {
 *   ring.fields.x[Ring.push(ring)] = n;
 * }
 * Ring.slotOf(ring, 4); // => 1
 * ring.fields.x[Ring.slotOf(ring, 4)]; // => 4
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const slotOf: {
  (n: number): <L extends Layout.Layout>(self: Ring<L>) => number;
  <L extends Layout.Layout>(self: Ring<L>, n: number): number;
} = dual(
  2,
  <L extends Layout.Layout>(self: Ring<L>, n: number): number =>
    n % self.capacity
);

/**
 * Forgets every record: `written` and `length` are 0 again.
 *
 * **When to use**
 *
 * To empty a ring that is state, such as an undo history when a level restarts.
 *
 * **Details**
 *
 * It only forgets the counts: each slot is cleaned as `push` hands it out. No reader of the ring
 * is told.
 *
 * **Example** (Emptying a ring)
 *
 * ```ts
 * import { Ring } from "arcadekit/core";
 *
 * const ring = Ring.make(3, { x: Float32Array });
 * Ring.push(ring);
 * Ring.push(ring);
 * Ring.clear(ring);
 * [ring.written, ring.length, Ring.pop(ring)]; // => [0, 0, -1]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const clear = <L extends Layout.Layout>(self: Ring<L>): void => {
  const ring = self as Internal<L>;
  ring.written = 0;
  ring.length = 0;
};
