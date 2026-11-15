/**
 * Events: how systems, handlers and scripts tell each other that something
 * happened, without knowing about each other.
 *
 *   const Collided = Event.define<{ a: Entity; b: Entity }>("Collided")
 *
 *   // in a system
 *   const collided = yield* Collided
 *   collided.emit({ a, b })                 // plain call, fine inside loops
 *   for (const hit of collided.read()) ...  // everything this system has not seen
 *
 *   // in a script
 *   const hits = yield* collided.wait       // suspend until some arrive
 *
 * Every system sees every event exactly once, whatever order the systems run
 * in. An event emitted by a later system is seen by an earlier one on the next
 * tick, so an event emitted while systems are running is kept until the end
 * of the following tick. One emitted between ticks is dropped at the end of
 * the next tick.
 */
import { Effect, Effectable } from "effect";

import { Events } from "./services";

export interface EventHandle<P> {
  /** Queues an event. Synchronous, so it can be called inside query loops. */
  readonly emit: (payload: P) => void;
  /** The events not yet seen through this handle, oldest first. */
  readonly read: () => readonly P[];
  /**
   * Suspends until at least one unseen event exists, then returns them all.
   * For scripts: a system that waits would not finish within its tick.
   */
  readonly wait: Effect.Effect<readonly P[]>;
}

/**
 * An event type. It is an Effect, so `yield*` gives a handle to its channel
 * in the current app.
 */
export class EventDef<P> extends Effectable.Class<
  EventHandle<P>,
  never,
  Events
> {
  readonly name: string;
  private effect: Effect.Effect<EventHandle<P>, never, Events> | undefined;

  constructor(name: string) {
    super();
    this.name = name;
  }

  asEffect(): Effect.Effect<EventHandle<P>, never, Events> {
    return (this.effect ??= Effect.map(Effect.service(Events), (bus) =>
      bus.handle(this)
    ));
  }
}

/** Defines an event type. The payload is any value; give its type explicitly. */
export const define = <P = void>(name: string): EventDef<P> =>
  new EventDef<P>(name);

const EMPTY: readonly never[] = Object.freeze([]);

/** The part of a channel that does not depend on its payload type. */
interface ChannelState {
  /** Sequence number of the oldest event still kept. Sequence numbers never repeat. */
  offset: number;
  /** Sequence number of the first event emitted once the current tick's systems began. */
  tickStart: number;
  /** One past the sequence number of the newest event. */
  readonly end: number;
  /** Number of events currently kept. */
  readonly size: number;
  /** Suspended `wait`s. Each returns true once it has resumed its fiber. */
  readonly waiters: Set<() => boolean>;
  /** Forgets the oldest `count` events. */
  dropOldest(count: number): void;
  /** Forgets every event from sequence number `end` on. */
  truncate(end: number): void;
}

class Channel<P> implements ChannelState {
  buffer: P[] = [];
  offset = 0;
  tickStart = 0;
  readonly readers: Map<string, Handle<P>> = new Map();
  readonly waiters: Set<() => boolean> = new Set();

  get end(): number {
    return this.offset + this.buffer.length;
  }

  get size(): number {
    return this.buffer.length;
  }

  dropOldest(count: number): void {
    this.buffer.splice(0, count);
    this.offset += count;
  }

  truncate(end: number): void {
    this.buffer.length = Math.max(0, end - this.offset);
  }
}

class Handle<P> implements EventHandle<P> {
  private readonly channel: Channel<P>;
  private cursor: number;

  constructor(channel: Channel<P>, cursor: number) {
    this.channel = channel;
    this.cursor = cursor;
  }

  readonly emit = (payload: P): void => {
    this.channel.buffer.push(payload);
  };

  readonly read = (): readonly P[] => {
    const { channel } = this;
    const { end } = channel;
    // Clamp: old events may have been dropped, and a failed action's events
    // may have been rolled back, since this handle last read.
    const from = Math.min(Math.max(this.cursor, channel.offset), end);
    this.cursor = end;
    return from === end ? EMPTY : channel.buffer.slice(from - channel.offset);
  };

  readonly wait: Effect.Effect<readonly P[]> = Effect.suspend(() => {
    const ready = this.read();
    if (ready.length > 0) {
      return Effect.succeed(ready);
    }
    return Effect.callback<readonly P[]>((resume) => {
      const waiter = (): boolean => {
        const batch = this.read();
        if (batch.length === 0) {
          return false;
        }
        resume(Effect.succeed(batch));
        return true;
      };
      this.channel.waiters.add(waiter);
      return Effect.sync(() => {
        this.channel.waiters.delete(waiter);
      });
    });
  });
}

/** A snapshot of how many events each channel held, for rolling back. */
export type EventMark = Map<object, number>;

/** All of an app's event channels. Provided as the `Events` service. */
export class EventBus {
  /**
   * Who is asking for handles right now. The app sets this before each
   * system and handler runs, which is what gives each of them its own
   * read position. Undefined means a script or outside code.
   * @internal
   */
  reader: string | undefined;

  // Keyed by event definition. The value is the `Channel<P>` of that
  // definition's own `P`, which a Map's type cannot say, so `channel` below
  // is the one place that restores it.
  private readonly channels: Map<object, ChannelState> = new Map();
  private readonly order: ChannelState[] = [];

  private channel<P>(def: EventDef<P>): Channel<P> {
    const existing = this.channels.get(def);
    if (existing !== undefined) {
      return existing as Channel<P>;
    }
    const channel = new Channel<P>();
    this.channels.set(def, channel);
    this.order.push(channel);
    return channel;
  }

  /**
   * A handle for the current reader. Systems and handlers get the same
   * handle every tick, starting from the oldest event still kept. Anyone
   * else gets a new handle that starts from now.
   */
  handle<P>(def: EventDef<P>): EventHandle<P> {
    const channel = this.channel(def);
    const { reader } = this;
    if (reader === undefined) {
      return new Handle(channel, channel.end);
    }
    let handle = channel.readers.get(reader);
    if (handle === undefined) {
      handle = new Handle(channel, channel.offset);
      channel.readers.set(reader, handle);
    }
    return handle;
  }

  /** Emits from outside any system, for example from UI or network code. */
  emit<P>(def: EventDef<P>, payload: P): void {
    this.channel(def).buffer.push(payload);
  }

  /** Number of events of a type currently kept. For tests and tooling. */
  pending<P>(def: EventDef<P>): number {
    return this.channel(def).size;
  }

  /**
   * Resumes scripts whose `wait` now has events. Returns whether any did.
   * @internal
   */
  resumeWaiters(): boolean {
    let resumed = false;
    for (const channel of this.order) {
      // Copied first: a resumed script may start or cancel other waits.
      for (const waiter of Array.from(channel.waiters)) {
        if (channel.waiters.has(waiter) && waiter()) {
          channel.waiters.delete(waiter);
          resumed = true;
        }
      }
    }
    return resumed;
  }

  /**
   * Drops events that existed before the systems of the tick that just ended
   * started running: by now every system has had a chance to read them.
   * @internal
   */
  endTick(): void {
    for (const channel of this.order) {
      const drop = channel.tickStart - channel.offset;
      if (drop > 0) {
        channel.dropOldest(drop);
      }
    }
  }

  /**
   * Called just before a tick's systems run. Events that already exist will
   * be seen by every system this tick; events emitted from here on may not
   * be, so they are kept for one more tick.
   * @internal
   */
  beginTick(): void {
    for (const channel of this.order) {
      channel.tickStart = channel.end;
    }
  }

  /** @internal */
  mark(): EventMark {
    const mark: EventMark = new Map();
    for (const channel of this.order) {
      mark.set(channel, channel.end);
    }
    return mark;
  }

  /** Removes every event emitted since `mark`. @internal */
  rollback(mark: EventMark): void {
    for (const channel of this.order) {
      channel.truncate(mark.get(channel) ?? channel.offset);
    }
  }
}
