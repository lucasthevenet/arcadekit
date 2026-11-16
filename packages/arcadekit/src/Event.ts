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
 *
 * Give an event a schema and it can be written down, for a save, a tool or
 * another machine:
 *
 *   const Collided = Event.define("Collided", Schema.Struct({ a: EntityId, b: EntityId }))
 *
 * The payload type comes from the schema. Emitting stays a plain call with
 * no check: the schema is used when the event leaves the program, by
 * `Event.encode` and `Event.decode`.
 */
import { Cause, Data, Effect, Effectable, Exit, Schema } from "effect";

import { LoadRefused } from "./Save";
import type { SavedEvents } from "./Save";
import { Events } from "./Services";

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
  /**
   * Converts a payload to and from JSON. Derived from the schema the event
   * was defined with; undefined for an event with a type and no schema.
   */
  readonly codec: Schema.Codec<P, unknown> | undefined;
  private effect: Effect.Effect<EventHandle<P>, never, Events> | undefined;

  constructor(name: string, codec?: Schema.Codec<P, unknown>) {
    super();
    this.name = name;
    this.codec = codec;
  }

  asEffect(): Effect.Effect<EventHandle<P>, never, Events> {
    return (this.effect ??= Effect.map(Effect.service(Events), (bus) =>
      bus.handle(this)
    ));
  }
}

/**
 * Defines an event type.
 *
 * With a schema, the payload type is inferred from it and the event can be
 * written down: `Event.define("Collided", Schema.Struct({ ... }))`.
 *
 * Without one, give the payload's type: `Event.define<Payload>("Collided")`.
 * Such an event stays inside the program, and a game cannot be saved while
 * one is waiting to be read.
 *
 * An event's name is its identity in an app: two different events with one
 * name are refused when the second is first used. A game that saves lists
 * its events in a plugin's `events`, so that a save which holds some can be
 * read: see `Plugin.make`.
 */
export function define<P = void>(name: string): EventDef<P>;
export function define<S extends Schema.Codec<unknown, unknown>>(
  name: string,
  payload: S
): EventDef<S["Type"]>;
export function define(
  name: string,
  payload?: Schema.Codec<unknown, unknown>
): EventDef<unknown> {
  return new EventDef<unknown>(
    name,
    payload === undefined ? undefined : Schema.toCodecJson(payload)
  );
}

/** An event's payload could not be turned into JSON, or read back from it. */
export class InvalidEvent extends Data.TaggedError("InvalidEvent")<{
  readonly event: string;
  /** What was wrong: the schema's report, or that the event has no schema. */
  readonly message: string;
}> {}

const convert = <A>(
  def: EventDef<any>,
  run: (codec: Schema.Codec<any, unknown>) => Exit.Exit<A, unknown>
): Exit.Exit<A, InvalidEvent> => {
  if (def.codec === undefined) {
    return Exit.fail(
      new InvalidEvent({
        event: def.name,
        message: `The event "${def.name}" was defined with a type and no schema, so it cannot be written down. Give Event.define a schema.`,
      })
    );
  }
  const exit = run(def.codec);
  if (Exit.isSuccess(exit)) {
    return Exit.succeed(exit.value);
  }
  const error = Cause.squash(exit.cause);
  return Exit.fail(
    new InvalidEvent({
      event: def.name,
      message: error instanceof Error ? error.message : String(error),
    })
  );
};

/** An event's payload in its JSON form, for a save, a tool or the network. */
export const encode = <P>(
  def: EventDef<P>,
  payload: P
): Exit.Exit<unknown, InvalidEvent> =>
  convert(def, (codec) => Schema.encodeUnknownExit(codec)(payload));

/** An event's payload read back from its JSON form, checked against its schema. */
export const decode = <P>(
  def: EventDef<P>,
  data: unknown
): Exit.Exit<P, InvalidEvent> =>
  convert(def, (codec) => Schema.decodeUnknownExit(codec)(data));

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
  readonly def: EventDef<P>;
  buffer: P[] = [];
  offset = 0;
  tickStart = 0;
  readonly readers: Map<string, Handle<P>> = new Map();
  readonly waiters: Set<() => boolean> = new Set();

  constructor(def: EventDef<P>) {
    this.def = def;
  }

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

  /** How far this handle has read: the sequence number of its next event. */
  get position(): number {
    return this.cursor;
  }

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
  private readonly order: Channel<any>[] = [];
  private readonly names: Map<string, EventDef<any>> = new Map();
  /** The events a plugin or the app lists: the ones a save can hold. */
  private readonly listed: Set<EventDef<any>> = new Set();

  private channel<P>(def: EventDef<P>): Channel<P> {
    const existing = this.channels.get(def);
    if (existing !== undefined) {
      return existing as Channel<P>;
    }
    // The name is how a save, a tool and another machine know the event.
    const known = this.names.get(def.name);
    if (known !== undefined && known !== def) {
      throw new Error(
        `Two different events are both named "${def.name}". An event's name identifies it in an app, so give each its own, prefixed with the feature it belongs to.`
      );
    }
    this.names.set(def.name, def);
    const channel = new Channel<P>(def);
    this.channels.set(def, channel);
    this.order.push(channel);
    return channel;
  }

  /**
   * Tells the bus about an event a plugin or the app lists. Its channel is
   * there from the start, so a save that holds some of its events can be
   * read before anything has asked for it, and channels stand in the order
   * they are listed in, on a fresh start and after a load alike.
   * @internal
   */
  register(def: EventDef<any>): void {
    this.channel(def);
    this.listed.add(def);
  }

  /**
   * The events waiting to be read, in their JSON form, with how far each
   * system and handler had read. Fails on one that has no schema, or whose
   * payload its schema does not take, or that no plugin lists: a save that
   * held it could not be loaded.
   * @internal
   */
  save(): Exit.Exit<SavedEvents[], InvalidEvent> {
    const out: SavedEvents[] = [];
    for (const channel of this.order) {
      if (channel.size === 0) {
        continue;
      }
      const payloads: unknown[] = [];
      for (const payload of channel.buffer) {
        const data = encode(channel.def, payload);
        if (Exit.isFailure(data)) {
          return Exit.fail(Cause.squash(data.cause) as InvalidEvent);
        }
        payloads.push(data.value);
      }
      if (!this.listed.has(channel.def)) {
        return Exit.fail(
          new InvalidEvent({
            event: channel.def.name,
            message: `The event "${channel.def.name}" is waiting to be read, and no plugin lists it, so a save that held it could not be loaded. List it in a plugin's \`events\`, or in the app's.`,
          })
        );
      }
      const read: Record<string, number> = {};
      for (const [reader, handle] of channel.readers) {
        const count = handle.position - channel.offset;
        if (count > 0) {
          read[reader] = Math.min(count, channel.size);
        }
      }
      out.push({ name: channel.def.name, payloads, read });
    }
    // In order of name, so that the same game always saves the same bytes.
    return Exit.succeed(
      out.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    );
  }

  /**
   * Puts the events of a save back into their channels, as they were
   * waiting, each reader where it was. Nothing is trusted: an event no
   * plugin lists, or a payload its schema no longer takes, refuses the
   * load, and no channel is changed.
   * @internal
   */
  restore(saved: readonly SavedEvents[]): Exit.Exit<void, LoadRefused> {
    const read: { channel: Channel<any>; payloads: unknown[] }[] = [];
    for (const events of saved) {
      const def = this.names.get(events.name);
      if (def === undefined || !this.listed.has(def)) {
        return Exit.fail(
          new LoadRefused({
            problem: "unknown event",
            message: `The save holds events named "${events.name}" that were waiting to be read, and no plugin lists an event of that name. List it in a plugin's \`events\`, or in the app's.`,
          })
        );
      }
      const payloads: unknown[] = [];
      for (const data of events.payloads) {
        const payload = decode(def, data);
        if (Exit.isFailure(payload)) {
          return Exit.fail(
            new LoadRefused({
              problem: "event changed",
              message: `The save holds an event "${events.name}" that no longer reads: ${(Cause.squash(payload.cause) as InvalidEvent).message}`,
            })
          );
        }
        payloads.push(payload.value);
      }
      read.push({ channel: this.channel(def), payloads });
    }
    for (const [index, { channel, payloads }] of read.entries()) {
      for (const payload of payloads) {
        channel.buffer.push(payload);
      }
      // Whoever had read some of them goes on from where it was.
      for (const [reader, count] of Object.entries(saved[index]!.read)) {
        channel.readers.set(
          reader,
          new Handle(channel, channel.offset + Math.min(count, channel.size))
        );
      }
    }
    return Exit.void;
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
