/**
 * Events let systems, handlers and scripts signal that something happened,
 * without knowing about each other.
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
 * in. An earlier system sees an event emitted by a later one on the next tick,
 * so an event emitted while systems are running is kept until the end of the
 * following tick. An event emitted between ticks is dropped at the end of the
 * next tick. Events aren't kept for a system that `System.runIf` has disabled:
 * when it runs again, the events from the ticks it skipped are gone.
 *
 * Give an event a schema to make it serializable, for a save, a tool or another
 * machine:
 *
 *   const Collided = Event.define("Collided", Schema.Struct({ a: EntityId, b: EntityId }))
 *
 * The payload type is inferred from the schema. Emitting is still a plain call
 * with no validation: the schema is only used when the event leaves the
 * program, by `Event.encode` and `Event.decode`.
 */
import { Cause, Data, Effect, Effectable, Exit, Schema } from "effect";

import type { SavedEvents } from "./Save";
import { Events } from "./Services";

/**
 * A system's handle to one event type, from `yield* SomeEvent`: it emits
 * events, and reads the ones it hasn't seen yet.
 *
 * @category Models
 */
export interface EventHandle<P> {
  /** Queues an event. Synchronous, so it can be called inside query loops. */
  readonly emit: (payload: P) => void;
  /** Returns the events not yet seen through this handle, oldest first. */
  readonly read: () => readonly P[];
  /**
   * Suspends until at least one unseen event exists, then returns them all.
   * Meant for scripts: a system that waits would not finish within its tick.
   */
  readonly wait: Effect.Effect<readonly P[]>;
}

/**
 * An event type. It is an Effect, so `yield*` returns a handle to its channel
 * in the current app.
 *
 * @category Models
 */
export class EventDef<P> extends Effectable.Class<
  EventHandle<P>,
  never,
  Events
> {
  readonly name: string;
  /**
   * Converts a payload to and from JSON. Derived from the event's schema;
   * undefined for an event defined with only a type.
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
 * With a schema, the payload type is inferred from it and the event is
 * serializable: `Event.define("Collided", Schema.Struct({ ... }))`.
 *
 * Without one, pass the payload type: `Event.define<Payload>("Collided")`. Such
 * an event stays inside the program, and a game can't be saved while one is
 * waiting to be read.
 *
 * An event's name is its identity within an app: when two different events
 * share a name, the second is refused the first time it is used.
 *
 * @category Constructors
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

/**
 * An event's payload couldn't be encoded to JSON, or decoded from it.
 *
 * @category Errors
 */
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

/**
 * Encodes an event's payload to its JSON form, for a save, a tool or the
 * network. Fails with `InvalidEvent` when the event has no schema, or its
 * schema rejects the payload.
 *
 * @category Codecs
 */
export const encode = <P>(
  def: EventDef<P>,
  payload: P
): Exit.Exit<unknown, InvalidEvent> =>
  convert(def, (codec) => Schema.encodeUnknownExit(codec)(payload));

/**
 * Decodes an event's payload from its JSON form, validated against its schema.
 * Fails with `InvalidEvent` when the event has no schema, or the data doesn't
 * match it.
 *
 * @category Codecs
 */
export const decode = <P>(
  def: EventDef<P>,
  data: unknown
): Exit.Exit<P, InvalidEvent> =>
  convert(def, (codec) => Schema.decodeUnknownExit(codec)(data));

const EMPTY: readonly never[] = Object.freeze([]);

/**
 * The prefix of a reader's name when it is a frame-stage or input-stage system.
 * Such a reader isn't part of the simulation: it can't emit, it isn't saved,
 * and events are kept for it until the frame stage next runs.
 *
 * @category Constants
 */
export const FRAME_READER = "frame:";

/**
 * How many ticks events are kept for a between-ticks stage that has stopped
 * running, or never ran, before the app treats it as gone: ten seconds at 60
 * Hz. A replay and a server run neither stage.
 */
const FRAME_PATIENCE = 600;

/** The part of a channel that does not depend on its payload type. */
interface ChannelState {
  /** Sequence number of the oldest event still kept. Sequence numbers never repeat. */
  offset: number;
  /**
   * Sequence number of the oldest event the simulation can still read. It
   * equals `offset` unless older events are kept for the frame stage, which the
   * simulation must not be able to observe.
   */
  tickOffset: number;
  /** One past the newest event the frame stage has had its chance to read. */
  frameSeen: number;
  /** One past the newest event the input stage has had its chance to read. */
  inputSeen: number;
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

/**
 * The reads made while an action's handler runs, for a refusal to roll back:
 * each handle that moved, and its previous position. One per bus.
 */
interface ReadLog {
  /** True from `mark` until `rollback` or `commit`. */
  open: boolean;
  readonly moved: { readonly handle: Handle<any>; readonly cursor: number }[];
}

class Channel<P> implements ChannelState {
  readonly def: EventDef<P>;
  readonly reads: ReadLog;
  buffer: P[] = [];
  offset = 0;
  tickOffset = 0;
  frameSeen = 0;
  inputSeen = 0;
  tickStart = 0;
  readonly readers = new Map<string, Handle<P>>();
  readonly waiters = new Set<() => boolean>();

  constructor(def: EventDef<P>, reads: ReadLog) {
    this.def = def;
    this.reads = reads;
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

  /** Puts the handle back where it was before a read. */
  rewind(cursor: number): void {
    this.cursor = cursor;
  }

  /** Whether this is a handle of the frame stage: it reads, and cannot emit. */
  private readonly forFrame: boolean;
  readonly emit: (payload: P) => void;

  /**
   * @param refusal what emitting throws, for the handle of a system that
   *                said what it writes and did not name this event
   */
  constructor(
    channel: Channel<P>,
    cursor: number,
    forFrame = false,
    refusal?: string
  ) {
    this.channel = channel;
    this.cursor = cursor;
    this.forFrame = forFrame;
    // Decided once, so that emitting stays one call with no check in it.
    this.emit = forFrame
      ? () => {
          throw new Error(
            `The event "${channel.def.name}" was emitted in the frame stage or the input stage. They run between ticks and must not change the game: an event from there would be one no replay could repeat. Emit from a system that runs in the tick, or issue an action with Actions.enqueue.`
          );
        }
      : refusal === undefined
        ? (payload) => {
            channel.buffer.push(payload);
          }
        : () => {
            throw new Error(refusal);
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

    // In an action's handler, a read is one a refusal takes back: the
    // events are unread again, as they are in a replay that never ran it.
    if (channel.reads.open && this.cursor !== end) {
      channel.reads.moved.push({ handle: this, cursor: this.cursor });
    }

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

/**
 * A record of how many events each channel held, for rolling back.
 *
 * @category Models
 */
export type EventMark = Map<object, number>;

/**
 * Everything a bus holds at one moment, kept in memory to return to: the events
 * as they are, without needing a schema, and every reader's position. Opaque:
 * `capture` creates it and `rewind` consumes it.
 *
 * @category Models
 */
export interface EventsMoment {
  readonly frames: boolean;
  readonly ticksSinceFrame: number;
  readonly inputs: boolean;
  readonly ticksSinceInput: number;
  readonly parked: ReadonlyMap<string, SavedEvents>;
  readonly channels: readonly {
    readonly channel: object;
    readonly buffer: readonly unknown[];
    readonly offset: number;
    readonly tickOffset: number;
    readonly frameSeen: number;
    readonly inputSeen: number;
    readonly tickStart: number;
    readonly cursors: ReadonlyMap<string, number>;
  }[];
}

/** All of an app's event channels. Provided as the `Events` service. */
/**
 * What a system that said what it reads and writes is held to, of events:
 * the app sets one on the bus while such a system runs.
 * @internal
 */
export interface EventGuard {
  /** Who runs under it, for a message: `System "Movement"`. */
  readonly who: string;
  /** What to do about a refusal, which ends its message. */
  readonly advice: string;
  /** The names of the events it may read. */
  readonly reads: ReadonlySet<string>;
  /** The names of the events it may emit, and so may read. */
  readonly emits: ReadonlySet<string>;
}

/**
 * Where an app's events wait to be read, with each reader's position. The app
 * holds one; a game reads and emits through an `EventHandle`.
 *
 * @category Models
 */
export class EventBus {
  /**
   * Who is asking for handles right now. The app sets this before each
   * system and handler runs, which is what gives each of them its own
   * read position. Undefined means a script or outside code.
   * @internal
   */
  reader: string | undefined;
  /**
   * What whoever is asking said it would read and emit, when it said: an
   * event it did not name is refused where it is asked for, and one it
   * only reads where it is emitted.
   * @internal
   */
  guard: EventGuard | undefined;

  // Keyed by event definition. The value is the `Channel<P>` of that
  // definition's own `P`, which a Map's type cannot say, so `channel` below
  // is the one place that restores it.
  private readonly channels = new Map<object, ChannelState>();
  private readonly order: Channel<any>[] = [];
  /** Events read from a save, waiting for their channel to be asked for. */
  private readonly parked = new Map<string, SavedEvents>();
  private readonly names = new Map<string, EventDef<any>>();
  private readonly reads: ReadLog = { open: false, moved: [] };
  /** True while events are kept for a frame stage that is running. */
  private frames = false;
  private ticksSinceFrame = 0;
  /** True while events are kept for an input stage that is running. */
  private inputs = false;
  private ticksSinceInput = 0;

  /**
   * Told once, by the app, which of the two stages between ticks it has
   * systems in. Events are kept for those from the first tick on, so that
   * such a system hears the events of the ticks before it first ran.
   * @internal
   */
  keepFor(stages: { readonly frame: boolean; readonly input: boolean }): void {
    this.frames = stages.frame;
    this.inputs = stages.input;
  }

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
    const channel = new Channel<P>(def, this.reads);
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
   * Returns a handle for the current reader. Systems and handlers get the same
   * handle every tick, starting from the oldest event still kept. Any other
   * caller gets a new handle that starts from now.
   */
  handle<P>(def: EventDef<P>): EventHandle<P> {
    const channel = this.channel(def);
    const { guard, reader } = this;
    const emits = guard === undefined || guard.emits.has(def.name);

    if (!emits && !guard!.reads.has(def.name)) {
      throw new Error(
        `${guard!.who} asked for the event "${def.name}", which is not among what it said it reads and writes.${guard!.advice}`
      );
    }

    if (reader === undefined) {
      return new Handle(channel, channel.end);
    }

    let handle = channel.readers.get(reader);

    if (handle === undefined) {
      // From the oldest event kept: `read` goes no further back than its
      // reader may, which for the simulation is `tickOffset`. What a
      // reader said it emits does not change, so its handle is told once.
      handle = new Handle(
        channel,
        channel.offset,
        reader.startsWith(FRAME_READER),
        emits
          ? undefined
          : `${guard!.who} emitted the event "${def.name}", which it said it reads and did not say it writes.${guard!.advice}`
      );
      channel.readers.set(reader, handle);
    }

    return handle;
  }

  /** Emits from outside any system, for example from UI or network code. */
  emit<P>(def: EventDef<P>, payload: P): void {
    this.channel(def).buffer.push(payload);
  }

  /** Returns the number of events of a type currently kept. For tests and tooling. */
  pending<P>(def: EventDef<P>): number {
    return this.channel(def).size;
  }

  /**
   * Whether an event is kept that some system of the tick has not had its
   * chance at: one emitted by a system, which the systems before it hear
   * in the tick that follows, or one emitted between ticks.
   * @internal
   */
  waiting(): boolean {
    for (const channel of this.order) {
      if (channel.size > 0) {
        return true;
      }
    }

    return false;
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
    // A stage that has not run for a long time is taken to be gone.
    if (this.frames && ++this.ticksSinceFrame > FRAME_PATIENCE) {
      this.frames = false;
    }

    if (this.inputs && ++this.ticksSinceInput > FRAME_PATIENCE) {
      this.inputs = false;
    }

    for (const channel of this.order) {
      if (channel.tickStart > channel.tickOffset) {
        channel.tickOffset = channel.tickStart;
      }

      // Kept a little longer for the stages between ticks: for the frame
      // stage, if several ticks ran since it last did, and for the input
      // stage, which runs before a tick and would otherwise never hear
      // what that tick's actions emitted. The simulation reads from
      // `tickOffset` either way.
      let keep = channel.tickOffset;

      if (this.frames) {
        keep = Math.min(keep, channel.frameSeen);
      }

      if (this.inputs) {
        keep = Math.min(keep, channel.inputSeen);
      }

      const drop = keep - channel.offset;

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
   * Called when the input stage has run: its systems have had their chance
   * at every event there is.
   * @internal
   */
  endInput(): void {
    this.inputs = true;
    this.ticksSinceInput = 0;

    for (const channel of this.order) {
      channel.inputSeen = channel.end;
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

  /**
   * The bus as it stands, to come back to with `rewind`. Between ticks.
   * @internal
   */
  capture(): EventsMoment {
    return {
      frames: this.frames,
      ticksSinceFrame: this.ticksSinceFrame,
      inputs: this.inputs,
      ticksSinceInput: this.ticksSinceInput,
      parked: new Map(this.parked),
      channels: this.order.map((channel) => {
        const cursors = new Map<string, number>();

        for (const [reader, handle] of channel.readers) {
          cursors.set(reader, handle.position);
        }

        return {
          channel,
          buffer: channel.buffer.slice(),
          offset: channel.offset,
          tickOffset: channel.tickOffset,
          frameSeen: channel.frameSeen,
          inputSeen: channel.inputSeen,
          tickStart: channel.tickStart,
          cursors,
        };
      }),
    };
  }

  /**
   * Puts the bus back as it was when `moment` was captured: the events
   * that were waiting then, and everyone's place in them. A reader that
   * has come since starts over, and a kind of event that was first used
   * since has none waiting.
   * @internal
   */
  rewind(moment: EventsMoment): void {
    this.frames = moment.frames;
    this.ticksSinceFrame = moment.ticksSinceFrame;
    this.inputs = moment.inputs;
    this.ticksSinceInput = moment.ticksSinceInput;
    this.parked.clear();

    for (const [name, saved] of moment.parked) {
      this.parked.set(name, saved);
    }

    const captured = new Map(
      moment.channels.map((entry) => [entry.channel, entry])
    );

    for (const channel of this.order) {
      const was = captured.get(channel);

      if (was === undefined) {
        channel.buffer = [];
        channel.tickOffset = channel.offset;
        channel.frameSeen = channel.offset;
        channel.inputSeen = channel.offset;
        channel.tickStart = channel.offset;
        channel.readers.clear();
        continue;
      }

      channel.buffer = was.buffer.slice();
      channel.offset = was.offset;
      channel.tickOffset = was.tickOffset;
      channel.frameSeen = was.frameSeen;
      channel.inputSeen = was.inputSeen;
      channel.tickStart = was.tickStart;

      for (const [reader, handle] of channel.readers) {
        const at = was.cursors.get(reader);

        if (at === undefined) {
          channel.readers.delete(reader);
        } else {
          handle.rewind(at);
        }
      }
    }
  }

  /**
   * Marks where the channels end, before an action's handler runs. Until
   * `rollback` or `commit`, the reads made are remembered as well.
   * @internal
   */
  mark(): EventMark {
    const mark: EventMark = new Map();

    for (const channel of this.order) {
      mark.set(channel, channel.end);
    }

    this.reads.open = true;

    return mark;
  }

  /**
   * Takes back what happened since `mark`: every event emitted is removed,
   * and every event read is unread.
   * @internal
   */
  rollback(mark: EventMark): void {
    for (const channel of this.order) {
      channel.truncate(mark.get(channel) ?? channel.tickOffset);
    }

    // Newest first, so that a handle that read twice ends where it began.
    const { moved } = this.reads;

    for (let i = moved.length - 1; i >= 0; i--) {
      moved[i]!.handle.rewind(moved[i]!.cursor);
    }

    this.commit();
  }

  /** Keeps what happened since `mark`. @internal */
  commit(): void {
    this.reads.open = false;
    this.reads.moved.length = 0;
  }
}
