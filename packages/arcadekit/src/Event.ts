/**
 * Events let systems and handlers signal that something happened,
 * without knowing about each other.
 *
 *   const Collided = Event.define("Collided", Schema.Struct({ a: EntityId, b: EntityId }))
 *
 *   // in a system
 *   const collided = yield* Collided
 *   collided.emit({ a, b })                 // plain call, fine inside loops
 *   for (const hit of collided.read()) ...  // everything this system has not seen
 *
 * Every system sees every event exactly once, whatever order the systems run
 * in. An earlier system sees an event emitted by a later one on the next tick,
 * so an event emitted while systems are running is kept until the end of the
 * following tick. An event emitted between ticks is dropped at the end of the
 * next tick. Events aren't kept for a system that `System.runIf` has disabled:
 * when it runs again, the events from the ticks it skipped are gone, as are
 * the changes its change queries would have seen in them.
 *
 * The payload type is inferred from the event's schema. Emitting is a plain
 * call with no validation: the schema is only used when the event leaves the
 * program, for a save, a tool or another machine, by `Event.encode` and
 * `Event.decode`.
 */
import { Cause, Data, Effect, Effectable, Exit, Schema } from "effect";

import { defineList } from "./ecs/list";
import type { ListDef } from "./ecs/list";
import type { World } from "./ecs/world";
import type { SavedEvents } from "./Save";
import { Events } from "./Services";

/**
 * A system's handle to one event type, from `yield* SomeEvent`: it emits
 * events, and reads the ones it hasn't seen yet.
 *
 * @category Models
 */
export interface EventHandle<P> {
  /**
   * Queues an event. Synchronous, so it can be called inside query loops. A
   * method, so that any event is an `EventDef<unknown>`.
   */
  emit(payload: P): void;
  /** Returns the events not yet seen through this handle, oldest first. */
  readonly read: () => readonly P[];
}

// Every event this program has defined, by name, so that an app can load a
// save that holds one it hasn't met yet. Of two definitions with one name, as
// a module that is loaded again under hot reload makes, it is the newer. An
// app that meets both refuses the second.
const defined = new Map<string, EventDef<unknown>>();
// The event each event's list in a world is of, for a bus to find the events
// a loaded or restored world holds.
const ofList = new WeakMap<ListDef, EventDef<unknown>>();

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
  /** Converts a payload to and from JSON. Derived from the event's schema. */
  readonly codec: Schema.Codec<P, unknown>;
  /**
   * The world's list of these events that the simulation has yet to read,
   * under the event's name, each in its JSON form in a snapshot and the hash.
   * @internal
   */
  readonly list: ListDef<P>;
  private effect: Effect.Effect<EventHandle<P>, never, Events> | undefined;

  constructor(name: string, codec: Schema.Codec<P, unknown>) {
    super();
    this.name = name;
    this.codec = codec;
    this.list = defineList<P>(
      name,
      {
        encode: (payload) => {
          const data = encode(this, payload);
          if (Exit.isFailure(data)) {
            throw new Error(describeFailure(data.cause));
          }
          return data.value;
        },
        decode: (data) => {
          const payload = decode(this, data);
          if (Exit.isFailure(payload)) {
            throw new Error(describeFailure(payload.cause));
          }
          return payload.value;
        },
      },
      { label: `the "${name}" events waiting to be read` }
    );
    defined.set(name, this as EventDef<unknown>);
    ofList.set(this.list as ListDef, this as EventDef<unknown>);
  }

  asEffect(): Effect.Effect<EventHandle<P>, never, Events> {
    return (this.effect ??= Effect.map(Effect.service(Events), (bus) =>
      bus.handle(this)
    ));
  }
}

/**
 * Defines an event type, with the schema of its payload. The payload type is
 * inferred from the schema: `Event.define("Collided", Schema.Struct({ ... }))`.
 * An event with no payload takes only its name, `Event.define("Started")`,
 * and is emitted with `undefined`.
 *
 * An event's name is its identity within an app: when two different events
 * share a name, the second is refused the first time it is used.
 *
 * @category Constructors
 */
export function define(name: string): EventDef<void>;
export function define<S extends Schema.Codec<unknown, unknown>>(
  name: string,
  payload: S
): EventDef<S["Type"]>;
export function define(
  name: string,
  payload: Schema.Codec<unknown, unknown> = Schema.Void
): EventDef<unknown> {
  return new EventDef<unknown>(name, Schema.toCodecJson(payload));
}

/**
 * An event's payload couldn't be encoded to JSON, or decoded from it.
 *
 * @category Errors
 */
export class InvalidEvent extends Data.TaggedError("InvalidEvent")<{
  readonly event: string;
  /** What was wrong, as the schema reported it. */
  readonly message: string;
}> {}

/** What an `InvalidEvent` says was wrong. */
const describeFailure = (cause: Cause.Cause<InvalidEvent>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

const convert = <P, A>(
  def: EventDef<P>,
  run: (codec: Schema.Codec<P, unknown>) => Exit.Exit<A, unknown>
): Exit.Exit<A, InvalidEvent> => {
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
 * network. Fails with `InvalidEvent` when its schema rejects the payload.
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
 * Fails with `InvalidEvent` when the data doesn't match it.
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
}

/**
 * The reads made while an action's handler runs, for a refusal to roll back:
 * each handle that moved, and its previous position. One per bus.
 */
interface ReadLog {
  /** True from `mark` until `rollback` or `commit`. */
  open: boolean;
  readonly moved: {
    readonly handle: Handle<unknown>;
    readonly cursor: number;
  }[];
}

class Channel<P> implements ChannelState {
  readonly def: EventDef<P>;
  readonly reads: ReadLog;
  /**
   * The events the simulation can still read, from `tickOffset` on: the
   * world's list of them, which is the game's, and which the world saves,
   * hashes and puts back.
   */
  readonly list: P[];
  /**
   * The events before those, from `offset` on, kept only for the stages
   * between ticks, which are not the game's.
   */
  kept: P[] = [];
  offset = 0;
  tickOffset = 0;
  frameSeen = 0;
  inputSeen = 0;
  tickStart = 0;
  /** Sequence number of the first event emitted since the last tick ended. */
  since = 0;
  /** The events emitted from the end of the tick before the last to the end of the last. */
  last: readonly P[] = [];
  readonly readers: Map<string, Handle<P>> = new Map();
  /**
   * After a rewind, what each reader between ticks had already heard of the
   * ticks it goes over again, by reader, for a reader whose handle the rewind
   * dropped. A handle made for that reader takes it.
   */
  readonly echoes: Map<string, P[]> = new Map();
  /**
   * After a rewind, the sequence number from which events are of ticks no
   * reader between ticks has heard: until the ticks run again reach where the
   * game was, every event is one of them.
   */
  echoEnd = Number.POSITIVE_INFINITY;

  constructor(def: EventDef<P>, reads: ReadLog, list: P[]) {
    this.def = def;
    this.reads = reads;
    this.list = list;
    this.since = this.end;
  }

  get end(): number {
    return this.tickOffset + this.list.length;
  }

  /** How many events the simulation can still read. */
  get size(): number {
    return this.list.length;
  }

  /** The events kept from sequence number `from` on, oldest first: copies. */
  from(from: number): P[] {
    return from >= this.tickOffset
      ? this.list.slice(from - this.tickOffset)
      : this.kept.slice(Math.max(0, from - this.offset)).concat(this.list);
  }

  /** Forgets the oldest `count` events of those kept, and returns them. */
  dropOldest(count: number): P[] {
    this.offset += count;
    return this.kept.splice(0, count);
  }

  /** Forgets every event from sequence number `end` on. */
  truncate(end: number): void {
    this.list.length = Math.max(0, end - this.tickOffset);
  }

  /**
   * The simulation can no longer read the events before sequence number
   * `until`: they leave the world's list, and are kept for the stages between
   * ticks until `dropOldest`.
   */
  pass(until: number): void {
    const count = until - this.tickOffset;
    if (count <= 0) {
      return;
    }
    for (const event of this.list.splice(0, count)) {
      this.kept.push(event);
    }
    this.tickOffset = until;
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
  readonly emit: EventHandle<P>["emit"];
  /**
   * After a rewind, the events this handle had already heard of the ticks the
   * game goes over again. As those ticks emit them again, they are taken out
   * here and not heard twice.
   */
  echo: P[] | undefined;

  constructor(
    channel: Channel<P>,
    cursor: number,
    forFrame = false,
    echo?: P[]
  ) {
    this.channel = channel;
    this.cursor = cursor;
    this.forFrame = forFrame;
    this.echo = echo;
    // Decided once, so that emitting stays one call with no check in it.
    this.emit = forFrame
      ? () => {
          throw new Error(
            `The event "${channel.def.name}" was emitted in the frame stage or the input stage. They run between ticks and must not change the game: an event from there would be one no replay could repeat. Emit from a system that runs in the tick, or issue an action with Actions.enqueue.`
          );
        }
      : (payload) => {
          channel.list.push(payload);
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
    if (from === end) {
      return EMPTY;
    }
    const events = channel.from(from);
    const { echo } = this;
    if (echo === undefined) {
      return events;
    }
    // Events of the ticks a rewind goes over again: one this handle heard
    // before the rewind is heard once, and only what is new is read.
    const heard = Math.min(end, channel.echoEnd) - from;
    const fresh: P[] = [];
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      const at = i < heard ? echo.findIndex((was) => same(was, event)) : -1;
      if (at === -1) {
        fresh.push(event);
      } else {
        echo.splice(at, 1);
      }
    }
    if (end >= channel.echoEnd || echo.length === 0) {
      this.echo = undefined;
    }
    return fresh;
  };
}

/**
 * Whether two payloads are the same event: equal primitives, or arrays and
 * plain objects whose entries are the same.
 */
const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) {
    return true;
  }
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null ||
    Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)
  ) {
    return false;
  }
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return (
      a.length === other.length && a.every((item, i) => same(item, other[i]))
    );
  }
  const proto: unknown = Object.getPrototypeOf(a);
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  const keys = Object.keys(a);
  const record = b as Record<string, unknown>;
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        same((a as Record<string, unknown>)[key], record[key])
    )
  );
};

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
  readonly channels: readonly {
    readonly channel: object;
    /** What was kept for the stages between ticks: the world holds the rest. */
    readonly kept: readonly unknown[];
    readonly end: number;
    readonly offset: number;
    readonly tickOffset: number;
    readonly frameSeen: number;
    readonly inputSeen: number;
    readonly tickStart: number;
    readonly cursors: ReadonlyMap<string, number>;
  }[];
  /** What the bus drops from now on, for a rewind to this moment. */
  readonly dropped: Dropped;
}

/**
 * The events a bus dropped at the end of one tick, and what it dropped after:
 * a list only moments hold the start of, so what was dropped before the
 * oldest moment still held is forgotten.
 */
interface Dropped {
  drops: { readonly channel: object; readonly events: readonly unknown[] }[];
  next: Dropped | undefined;
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
   * read position. Undefined means outside code.
   * @internal
   */
  reader: string | undefined;

  // Keyed by event definition. The value is the `Channel<P>` of that
  // definition's own `P`, which a Map's type cannot say, so `channel` below
  // is the one place that restores it.
  private readonly channels: Map<object, ChannelState> = new Map();
  private readonly order: Channel<unknown>[] = [];
  private readonly names: Map<string, EventDef<unknown>> = new Map();
  private readonly reads: ReadLog = { open: false, moved: [] };
  /** True while events are kept for a frame stage that is running. */
  private frames = false;
  private ticksSinceFrame = 0;
  /** True while events are kept for an input stage that is running. */
  private inputs = false;
  private ticksSinceInput = 0;
  /**
   * Where the events dropped from now on go, once a moment has been
   * captured: a rewind to a moment tells the stages between ticks what they
   * heard of them already. Only moments hold the list from where they were
   * captured, so what no moment can go back to is forgotten.
   */
  private dropped: Dropped | undefined;
  /**
   * After a rewind, the number of ticks the game had run before it went back:
   * once it has run as many again, events are new to the stages between ticks.
   */
  private echoUntil: number | undefined;
  private readonly world: World;

  /** Keeps the events the simulation has yet to read in `world`'s lists. */
  constructor(world: World) {
    this.world = world;
    world._onRestore(() => {
      this.restored();
    });
  }

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
        `Two different events are both named "${def.name}". An event's name identifies it in an app and in a save, so give each its own, prefixed with the feature it belongs to.`
      );
    }
    this.names.set(def.name, def);
    const channel = new Channel<P>(def, this.reads, this.world._list(def.list));
    this.channels.set(def, channel);
    this.order.push(channel);
    return channel;
  }

  /**
   * How far each system and handler had read the events waiting to be read,
   * which the world holds, by event in order of name.
   * @internal
   */
  save(): SavedEvents[] {
    const out: SavedEvents[] = [];
    for (const channel of this.order) {
      const read: Record<string, number> = {};
      let readers = 0;
      for (const [reader, handle] of channel.readers) {
        const count = handle.position - channel.tickOffset;
        // Not a stage between ticks: those are not the game's.
        if (count > 0 && !reader.startsWith(FRAME_READER)) {
          read[reader] = Math.min(count, channel.size);
          readers++;
        }
      }
      if (readers > 0) {
        out.push({ name: channel.def.name, read });
      }
    }
    // In order of name, so that the same game always saves the same bytes.
    return out.toSorted((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
  }

  /**
   * Takes every reader's place in the events a loaded world holds, as a save
   * holds them. Before anything has read. A place in an event this program
   * doesn't define, of which the world holds none, is dropped.
   * @internal
   */
  restore(saved: readonly SavedEvents[]): void {
    this.adopt();
    for (const events of saved) {
      const def = this.names.get(events.name) ?? defined.get(events.name);
      if (def === undefined) {
        continue;
      }
      const channel = this.channel(def);
      // Whoever had read some of them goes on from where it was.
      for (const [reader, count] of Object.entries(events.read)) {
        channel.readers.set(
          reader,
          new Handle(
            channel,
            channel.tickOffset + Math.min(count, channel.size)
          )
        );
      }
    }
  }

  /** A channel for each event the world holds, so that none waits unseen. */
  private adopt(): void {
    for (const list of this.world._lists()) {
      const def = ofList.get(list);
      if (def !== undefined) {
        this.channel(def);
      }
    }
  }

  /**
   * After `world.restore`, which put back the events of a snapshot: every
   * reader reads them as if it had read none, as in a loaded game, and what
   * was kept for the stages between ticks is gone.
   */
  private restored(): void {
    this.echoUntil = undefined;
    for (const channel of this.order) {
      channel.kept = [];
      channel.offset = channel.tickOffset;
      channel.frameSeen = channel.tickOffset;
      channel.inputSeen = channel.tickOffset;
      channel.tickStart = channel.tickOffset;
      channel.since = channel.end;
      channel.last = [];
      channel.echoes.clear();
      channel.echoEnd = Number.POSITIVE_INFINITY;
      for (const handle of channel.readers.values()) {
        handle.rewind(channel.tickOffset);
        handle.echo = undefined;
      }
    }
    this.adopt();
  }

  /**
   * Returns a handle for the current reader. Systems and handlers get the same
   * handle every tick, starting from the oldest event still kept. Any other
   * caller gets a new handle that starts from now.
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
      // A reader between ticks that a rewind dropped still doesn't hear
      // twice what it heard before it.
      const echo = channel.echoes.get(reader);
      channel.echoes.delete(reader);
      handle = new Handle(
        channel,
        channel.offset,
        reader.startsWith(FRAME_READER),
        echo
      );
      channel.readers.set(reader, handle);
    }
    return handle;
  }

  /** Emits from outside any system, for example from UI or network code. */
  emit<P>(def: EventDef<P>, payload: P): void {
    this.channel(def).list.push(payload);
  }

  /** Returns the number of events of a type currently kept. For tests and tooling. */
  pending<P>(def: EventDef<P>): number {
    return this.channel(def).size;
  }

  /**
   * The events emitted in the last tick, and between it and the one before,
   * by event name, in the order they were emitted: copies, for `app.inspect`.
   * @internal
   */
  lastTick(): Record<string, readonly unknown[]> {
    const out: Record<string, readonly unknown[]> = {};
    for (const channel of this.order) {
      if (channel.last.length > 0) {
        out[channel.def.name] = channel.last;
      }
    }
    return out;
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
   * Drops events that existed before the systems of the tick that just ended
   * started running: by now every system has had a chance to read them.
   * @internal
   */
  endTick(tick: number): void {
    if (this.echoUntil !== undefined && tick >= this.echoUntil) {
      this.closeEchoes();
    }
    const dropped = this.dropped;
    // A stage that has not run for a long time is taken to be gone.
    if (this.frames && ++this.ticksSinceFrame > FRAME_PATIENCE) {
      this.frames = false;
    }
    if (this.inputs && ++this.ticksSinceInput > FRAME_PATIENCE) {
      this.inputs = false;
    }
    for (const channel of this.order) {
      // Copied before they are dropped, for `app.inspect`.
      channel.last =
        channel.end > channel.since ? channel.from(channel.since) : [];
      channel.since = channel.end;
      channel.pass(channel.tickStart);
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
        const events = channel.dropOldest(drop);
        dropped?.drops.push({ channel, events });
      }
    }
    if (dropped !== undefined && dropped.drops.length > 0) {
      dropped.next = { drops: [], next: undefined };
      this.dropped = dropped.next;
    }
  }

  /** From here on, every event is new to the stages between ticks. */
  private closeEchoes(): void {
    this.echoUntil = undefined;
    for (const channel of this.order) {
      channel.echoEnd = channel.end;
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
    const moment: EventsMoment = {
      frames: this.frames,
      ticksSinceFrame: this.ticksSinceFrame,
      inputs: this.inputs,
      ticksSinceInput: this.ticksSinceInput,
      channels: this.order.map((channel) => {
        const cursors = new Map<string, number>();
        for (const [reader, handle] of channel.readers) {
          cursors.set(reader, handle.position);
        }
        return {
          channel,
          kept: channel.kept.slice(),
          end: channel.end,
          offset: channel.offset,
          tickOffset: channel.tickOffset,
          frameSeen: channel.frameSeen,
          inputSeen: channel.inputSeen,
          tickStart: channel.tickStart,
          cursors,
        };
      }),
      dropped: (this.dropped ??= { drops: [], next: undefined }),
    };
    return moment;
  }

  /**
   * Puts the bus back as it was when `moment` was captured: the events
   * that were waiting then, and everyone's place in them. A reader that
   * has come since starts over, and a kind of event that was first used
   * since has none waiting.
   *
   * A reader between ticks goes back too, but doesn't hear twice what it
   * heard before the rewind: until the game has run again the `from` ticks it
   * had run, an event it heard is taken out of what it reads, once.
   *
   * The events the simulation had yet to read are the world's, and come back
   * with it: this runs just before the world is rewound, while its lists
   * still hold the future the rewind gives up.
   * @internal
   */
  rewind(moment: EventsMoment, from: number, to: number): void {
    this.frames = moment.frames;
    this.ticksSinceFrame = moment.ticksSinceFrame;
    this.inputs = moment.inputs;
    this.ticksSinceInput = moment.ticksSinceInput;
    const captured = new Map(
      moment.channels.map((entry) => [entry.channel, entry])
    );
    // What was dropped since the moment, by channel, which the future given
    // up is all of: it is forgotten, and what is dropped from now on goes
    // where the moment holds. A moment captured in that future finds nothing
    // dropped after it.
    const since = new Map<object, unknown[]>();
    for (
      let node: Dropped | undefined = moment.dropped;
      node !== undefined;
      node = node.next
    ) {
      for (const { channel, events } of node.drops) {
        const kept = since.get(channel);
        if (kept === undefined) {
          since.set(channel, [...events]);
        } else {
          kept.push(...events);
        }
      }
      node.drops = [];
    }
    moment.dropped.next = undefined;
    this.dropped = moment.dropped;
    for (const channel of this.order) {
      const was = captured.get(channel);
      channel.last = [];
      // Everything this channel holds of the future it gives up, from the
      // sequence number `first` on: what a reader between ticks heard of it
      // is in there.
      const dropped = since.get(channel) ?? [];
      const told = [...dropped, ...channel.kept, ...channel.list];
      const first = channel.offset - dropped.length;
      channel.echoes.clear();
      channel.echoEnd = Number.POSITIVE_INFINITY;
      const heard = (reader: string, at: number): unknown[] | undefined => {
        const handle = channel.readers.get(reader)!;
        const start = Math.max(at, first) - first;
        const end = handle.position - first;
        return reader.startsWith(FRAME_READER) && end > start
          ? told.slice(start, end)
          : undefined;
      };
      if (was === undefined) {
        for (const reader of channel.readers.keys()) {
          const echo = heard(reader, 0);
          if (echo !== undefined) {
            channel.echoes.set(reader, echo);
          }
        }
        channel.kept = [];
        channel.tickOffset = channel.offset;
        channel.frameSeen = channel.offset;
        channel.inputSeen = channel.offset;
        channel.tickStart = channel.offset;
        channel.since = channel.offset;
        channel.readers.clear();
        continue;
      }
      for (const [reader, handle] of channel.readers) {
        const echo = heard(reader, was.cursors.get(reader) ?? was.offset);
        if (was.cursors.has(reader)) {
          handle.echo = echo;
        } else if (echo !== undefined) {
          channel.echoes.set(reader, echo);
        }
      }
      channel.kept = was.kept.slice();
      channel.offset = was.offset;
      channel.tickOffset = was.tickOffset;
      channel.frameSeen = was.frameSeen;
      channel.inputSeen = was.inputSeen;
      channel.tickStart = was.tickStart;
      channel.since = was.end;
      for (const [reader, handle] of channel.readers) {
        const at = was.cursors.get(reader);
        if (at === undefined) {
          channel.readers.delete(reader);
        } else {
          handle.rewind(at);
        }
      }
    }
    this.echoUntil = from;
    if (from <= to) {
      this.closeEchoes();
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
