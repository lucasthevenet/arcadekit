/**
 * Event buffers: what a run reports during its steps, held until its loop delivers it
 * (ADR-0008).
 *
 * An event is a rare, meaningful fact ("leveled up", "boss spawned"), and it crosses into the
 * UI, so a step reports few. `arcadekit/game`'s loop keeps one buffer for a run and drains it
 * after each frame's steps.
 *
 * @since 0.7.0
 */
import type { Types } from "effect";
import { Inspectable, Pipeable, Predicate } from "effect";
import { dual } from "effect/Function";

const TypeId = "~arcadekit/core/EventBuffer";

/**
 * The events pushed since the last drain, oldest first.
 *
 * **When to use**
 *
 * In a host that steps a simulation and delivers what it reports after the steps: a step pushes,
 * and the host drains.
 *
 * **Details**
 *
 * `pending` is read directly; only the module's functions change it. A drain hands over the
 * events it held and starts a new list, so a drain that finds none allocates nothing.
 *
 * **Example** (Holding a step's events until the frame ends)
 *
 * ```ts
 * import { EventBuffer } from "arcadekit/core";
 *
 * const events = EventBuffer.make<string>();
 * EventBuffer.push(events, "leveled up");
 * EventBuffer.push(events, "boss spawned");
 * events.pending.length; // => 2
 * EventBuffer.drain(events); // => ["leveled up", "boss spawned"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface EventBuffer<E>
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** The events pushed since the last drain, oldest first. */
  readonly pending: readonly E[];
}

/** What the module's functions write. */
type Internal<E> = Types.Mutable<EventBuffer<E>> & { pending: E[] };

const EMPTY: readonly never[] = [];

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: EventBuffer<unknown>) {
    return {
      _id: "EventBuffer",
      pending: this.pending.map((event) => Inspectable.toJson(event)),
    };
  },
};

/**
 * Checks whether a value is an event buffer.
 *
 * **When to use**
 *
 * Narrow an unknown value before pushing to it or draining it.
 *
 * **Example** (Recognising a buffer)
 *
 * ```ts
 * import { EventBuffer } from "arcadekit/core";
 *
 * EventBuffer.isEventBuffer(EventBuffer.make()); // => true
 * EventBuffer.isEventBuffer([]); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isEventBuffer = (value: unknown): value is EventBuffer<unknown> =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes an empty buffer of events of type `E`.
 *
 * **When to use**
 *
 * Once per host, for the events of the runs it steps.
 *
 * **Example** (Making a buffer)
 *
 * ```ts
 * import { EventBuffer } from "arcadekit/core";
 *
 * const events = EventBuffer.make<{ readonly kind: "LevelSolved" }>();
 * events.pending; // => []
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = <E>(): EventBuffer<E> => {
  const self = Object.create(Proto) as Internal<E>;
  self.pending = [];
  return self;
};

/**
 * Adds an event after those already held.
 *
 * **When to use**
 *
 * Wherever a step reports: the loop's `report` pushes here.
 *
 * **Example** (Reporting two events)
 *
 * ```ts
 * import { EventBuffer } from "arcadekit/core";
 *
 * const events = EventBuffer.make<string>();
 * EventBuffer.push(events, "a");
 * EventBuffer.push(events, "b");
 * events.pending; // => ["a", "b"]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const push: {
  <E>(event: E): (self: EventBuffer<E>) => void;
  <E>(self: EventBuffer<E>, event: E): void;
} = dual(2, <E>(self: EventBuffer<E>, event: E): void => {
  (self as Internal<E>).pending.push(event);
});

/**
 * Returns everything pushed since the last drain, oldest first, and empties the buffer.
 *
 * **When to use**
 *
 * After a frame's steps, to deliver what they reported.
 *
 * **Details**
 *
 * The list it returns is the buffer's own until then, and the buffer starts a new one, so the
 * caller may keep it. With nothing held, it returns one shared empty list.
 *
 * **Example** (Draining in order)
 *
 * ```ts
 * import { EventBuffer } from "arcadekit/core";
 *
 * const events = EventBuffer.make<string>();
 * EventBuffer.push(events, "a");
 * EventBuffer.push(events, "b");
 * EventBuffer.drain(events); // => ["a", "b"]
 * EventBuffer.drain(events); // => []
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const drain = <E>(self: EventBuffer<E>): readonly E[] => {
  const buffer = self as Internal<E>;
  if (buffer.pending.length === 0) {
    return EMPTY;
  }
  const drained = buffer.pending;
  buffer.pending = [];
  return drained;
};
