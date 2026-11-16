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
 * name are refused when the second is first used.
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

/**
 * What the name of a reader starts with when it is a system of the frame
 * stage. Such a reader is not part of the simulation: it cannot emit, it is
 * not saved, and events are kept for it until the frame stage next runs.
 */
export const FRAME_READER = "frame:";

/**
 * How many ticks events are kept for a frame stage that has stopped
 * running, before the app takes it to be gone: ten seconds at 60 Hz.
 */
const FRAME_PATIENCE = 600;

/** The part of a channel that does not depend on its payload type. */
interface ChannelState {
  /** Sequence number of the oldest event still kept. Sequence numbers never repeat. */
  offset: number;
  /**
   * Sequence number of the oldest event the simulation can still read. It
   * is `offset` unless older events are being kept for the frame stage,
   * which the simulation must not be able to tell.
   */
  tickOffset: number;
  /** One past the newest event the frame stage has had its chance to read. */
  frameSeen: number;
  /** Sequence number of the first event emitted once the current tick's systems began. */
  tickStart: number;
  /** One past the sequence number of the newest event. */
  readonly end: number;
  /** Number of events the simulation can still read. */
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
  tickOffset = 0;
  frameSeen = 0;
  tickStart = 0;
  readonly readers: Map<string, Handle<P>> = new Map();
  readonly waiters: Set<() => boolean> = new Set();

  constructor(def: EventDef<P>) {
    this.def = def;
  }

  get end(): number {
    return this.offset + this.buffer.length;
  }

  /** How many events the simulation can still read. */
  get size(): number {
    return this.end - this.tickOffset;
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

  /** Whether this is a handle of the frame stage: it reads, and cannot emit. */
  private readonly forFrame: boolean;
  readonly emit: (payload: P) => void;

  constructor(channel: Channel<P>, cursor: number, forFrame = false) {
    this.channel = channel;
    this.cursor = cursor;
    this.forFrame = forFrame;
    // Decided once, so that emitting stays one call with no check in it.
    this.emit = forFrame
      ? () => {
          throw new Error(
            `The event "${channel.def.name}" was emitted in the frame stage. The frame stage draws the game and must not change it: an event from there would be one no replay could repeat. Emit from a system that runs in the tick.`
          );
        }
      : (payload) => {
          channel.buffer.push(payload);
        };
  }

  readonly read = (): readonly P[] => {
    const { channel } = this;
    const { end } = channel;
    // Clamp: old events may have been dropped, and a failed action's events
    // may have been rolled back, since this handle last read. The frame
    // stage reads back to what is kept for it; the simulation no further
    // than it could if nothing were.
    const oldest = this.forFrame ? channel.offset : channel.tickOffset;
    const from = Math.min(Math.max(this.cursor, oldest), end);
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
  /** Events read from a save, waiting for their channel to be asked for. */
  private readonly parked: Map<string, SavedEvents> = new Map();
  private readonly names: Map<string, EventDef<any>> = new Map();
  /** True while events are kept for a frame stage that is running. */
  private frames = false;
  private ticksSinceFrame = 0;

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
    const saved = this.parked.get(def.name);
    if (saved !== undefined) {
      this.parked.delete(def.name);
      this.adopt(channel, saved);
    }
    return channel;
  }

  /** Puts the events of a save into their channel, as they were waiting. */
  private adopt<P>(channel: Channel<P>, saved: SavedEvents): void {
    for (const data of saved.payloads) {
      const payload = decode(channel.def, data);
      if (Exit.isFailure(payload)) {
        throw new Error(
          `The save holds an event "${saved.name}" that no longer reads: ${(Cause.squash(payload.cause) as Error).message}`
        );
      }
      channel.buffer.push(payload.value);
    }
    // Whoever had read some of them goes on from where it was.
    for (const [reader, count] of Object.entries(saved.read)) {
      channel.readers.set(
        reader,
        new Handle(channel, channel.offset + Math.min(count, channel.size))
      );
    }
  }

  /**
   * The events waiting to be read, in their JSON form, with how far each
   * system and handler had read. Fails on one that has no schema, or whose
   * payload its schema does not take.
   * @internal
   */
  save(): Exit.Exit<SavedEvents[], InvalidEvent> {
    const out: SavedEvents[] = [];
    for (const channel of this.order) {
      if (channel.size === 0) {
        continue;
      }
      const payloads: unknown[] = [];
      // What the simulation can read: not what is only kept for the frame
      // stage, whose readers are not saved either.
      for (const payload of channel.buffer.slice(
        channel.tickOffset - channel.offset
      )) {
        const data = encode(channel.def, payload);
        if (Exit.isFailure(data)) {
          return Exit.fail(Cause.squash(data.cause) as InvalidEvent);
        }
        payloads.push(data.value);
      }
      const read: Record<string, number> = {};
      for (const [reader, handle] of channel.readers) {
        const count = handle.position - channel.tickOffset;
        if (count > 0 && !reader.startsWith(FRAME_READER)) {
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
   * Takes the events of a save. Each kind is put into its channel when the
   * channel is first asked for, which is when its event is known here.
   * @internal
   */
  restore(saved: readonly SavedEvents[]): void {
    for (const events of saved) {
      const def = this.names.get(events.name);
      if (def === undefined) {
        this.parked.set(events.name, events);
      } else {
        this.adopt(this.channel(def), events);
      }
    }
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
      // From the oldest event kept: `read` goes no further back than its
      // reader may, which for the simulation is `tickOffset`.
      handle = new Handle(
        channel,
        channel.offset,
        reader.startsWith(FRAME_READER)
      );
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
    // A frame stage that has not run for a long time is taken to be gone.
    if (this.frames && ++this.ticksSinceFrame > FRAME_PATIENCE) {
      this.frames = false;
    }
    for (const channel of this.order) {
      if (channel.tickStart > channel.tickOffset) {
        channel.tickOffset = channel.tickStart;
      }
      // Kept a little longer for the frame stage, if several ticks ran
      // since it last did. The simulation reads from `tickOffset` either way.
      const drop =
        (this.frames
          ? Math.min(channel.tickOffset, channel.frameSeen)
          : channel.tickOffset) - channel.offset;
      if (drop > 0) {
        channel.dropOldest(drop);
      }
    }
  }

  /**
   * Called when the frame stage has run: its systems have had their chance
   * at every event there is.
   * @internal
   */
  endFrame(): void {
    this.frames = true;
    this.ticksSinceFrame = 0;
    for (const channel of this.order) {
      channel.frameSeen = channel.end;
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
      channel.truncate(mark.get(channel) ?? channel.tickOffset);
    }
  }
}
