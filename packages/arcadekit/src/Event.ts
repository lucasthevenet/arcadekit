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

import { SnapshotError } from "./ecs/snapshot";
import { isPlain } from "./ecs/store";
import type { Store } from "./ecs/store";
import type { World } from "./ecs/world";
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
  private effect: Effect.Effect<EventHandle<P>, never, Events> | undefined;

  constructor(name: string, codec: Schema.Codec<P, unknown>) {
    super();
    this.name = name;
    this.codec = codec;
    defined.set(name, this as EventDef<unknown>);
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

/** One event as it was emitted, with which event it is. */
interface Emitted {
  readonly def: EventDef<unknown>;
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// The tick's side: the events the simulation has yet to read
// ---------------------------------------------------------------------------

/** One event's values waiting in the world, and where each reader of the tick is. */
class Channel<P> {
  readonly def: EventDef<P>;
  /** What the tick can still read, oldest first. */
  values: P[] = [];
  /**
   * The number of the oldest value kept. A value's number is its place among
   * all that were emitted, so a reader's place outlives what is dropped.
   */
  base = 0;
  /** For each system and handler that has read, the number of the value it reads next. */
  readonly readers = new Map<string, number>();
  /** Where it ended when the tick's systems began: `close` drops what came before. */
  mark = 0;
  /** Where it ended when the transaction began. */
  txEnd = 0;

  constructor(def: EventDef<P>) {
    this.def = def;
  }

  /** One past the number of the newest value. */
  get end(): number {
    return this.base + this.values.length;
  }
}

/** What `Waiting` holds of one channel at a moment. */
interface ChannelMoment {
  readonly channel: Channel<unknown>;
  readonly values: readonly unknown[];
  readonly base: number;
  readonly readers: ReadonlyMap<string, number>;
}

/** What `Waiting` holds at a moment: the events by reference, with no schema. */
interface WaitingMoment {
  readonly channels: readonly ChannelMoment[];
  readonly emitted: readonly Emitted[];
}

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** What a snapshot holds of the waiting events: `Waiting.save`. */
const SavedWaiting = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    waiting: Schema.Array(Schema.Unknown),
    read: Schema.Record(Schema.String, Count),
  })
);

/** What goes before a message about the events of one type that are waiting. */
const labelOf = (name: string): string =>
  `the "${name}" events waiting to be read`;

/**
 * The name of the store that holds an app's waiting events, as a snapshot has
 * it: `readSnapshot(save.world).stores`. Each entry is `{ name, waiting, read }`:
 * the event's name, the events waiting in JSON form, oldest first, and for each
 * system and handler that has read some, how many.
 *
 * @category Constants
 */
export const STORE = "arcadekit/events";

/**
 * The events the simulation has yet to read, and where each system and
 * handler has read to: the game's, so the world holds them. It saves, hashes,
 * captures and rewinds them with the rest of the game, and takes back what a
 * refused action emitted and read.
 */
class Waiting implements Store<WaitingMoment> {
  readonly name = STORE;
  readonly betweenTicks = false;
  // Keyed by event definition. The value is the `Channel<P>` of that
  // definition's own `P`, which a Map's type cannot say, so `channel` below
  // is the one place that restores it.
  private readonly channels = new Map<object, Channel<unknown>>();
  private readonly names = new Map<string, EventDef<unknown>>();
  private readonly order: Channel<unknown>[] = [];
  /**
   * Every event emitted since `take`, in order: what the stages between ticks
   * are told of once the code that emitted them has ended.
   */
  private emitted: Emitted[] = [];
  private recording = false;
  private emittedMark = 0;
  /** In a transaction, the readers that moved, and where each was. */
  private readonly moved: {
    readonly channel: Channel<unknown>;
    readonly reader: string;
    readonly at: number | undefined;
  }[] = [];
  private readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  channel<P>(def: EventDef<P>): Channel<P> {
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
    const channel = new Channel<P>(def);
    this.channels.set(def, channel as Channel<unknown>);
    this.order.push(channel as Channel<unknown>);
    return channel;
  }

  emit<P>(channel: Channel<P>, payload: P): void {
    if (this.world.frozen) {
      throw new Error(
        `The event "${channel.def.name}" was emitted in the frame stage or the input stage. They run between ticks and must not change the game: an event from there would be one no replay could repeat. Emit from a system that runs in the tick, or issue an action with Actions.enqueue.`
      );
    }
    channel.values.push(payload);
    this.emitted.push({ def: channel.def, payload });
  }

  /** What `reader` has yet to read, oldest first, which it has then read. */
  read<P>(channel: Channel<P>, reader: string): readonly P[] {
    const { base, end, readers } = channel;
    const at = readers.get(reader);
    if (at === end) {
      return EMPTY;
    }
    // In an action's handler, a read is one a refusal takes back: the
    // events are unread again, as they are in a replay that never ran it.
    if (this.recording) {
      this.moved.push({ channel: channel as Channel<unknown>, reader, at });
    }
    readers.set(reader, end);
    // No further back than what is kept: what was dropped since it last read
    // is gone, and so is what a refused action emitted.
    const from = at === undefined || at < base ? base : Math.min(at, end);
    return from === end ? EMPTY : channel.values.slice(from - base);
  }

  /**
   * Before a tick's systems run. Events that already exist will be seen by
   * every system this tick; those emitted from here on may not be, so they
   * are kept for one more tick.
   */
  open(): void {
    for (const channel of this.order) {
      channel.mark = channel.end;
    }
  }

  /**
   * After a tick's systems have run: drops the events that existed before
   * they started, which every system has had its chance to read.
   */
  close(): void {
    for (const channel of this.order) {
      const count = channel.mark - channel.base;
      if (count > 0) {
        channel.values.splice(0, count);
        channel.base = channel.mark;
      }
    }
  }

  /** Whether an event is kept that some system of the tick has not had its chance at. */
  waiting(): boolean {
    for (const channel of this.order) {
      if (channel.values.length > 0) {
        return true;
      }
    }
    return false;
  }

  /** The events emitted since it was last called, in order. */
  take(): readonly Emitted[] {
    const { emitted } = this;
    if (emitted.length === 0) {
      return EMPTY;
    }
    this.emitted = [];
    return emitted;
  }

  // --- what the world asks of a store ----------------------------------------

  /** The channels that hold anything, in order of name. */
  private held(): Channel<unknown>[] {
    return this.order
      .filter((channel) => channel.values.length > 0)
      .toSorted((a, b) =>
        a.def.name < b.def.name ? -1 : a.def.name > b.def.name ? 1 : 0
      );
  }

  save(): unknown {
    const out: (typeof SavedWaiting.Type)[number][] = [];
    for (const { base, def, readers, values } of this.held()) {
      const waiting = values.map((payload) => {
        const data = encode(def, payload);
        if (Exit.isFailure(data)) {
          throw new SnapshotError(
            "cannot be saved",
            `Can't save ${labelOf(def.name)}: ${describeFailure(data.cause)}`
          );
        }
        if (!isPlain(data.value)) {
          throw new SnapshotError(
            "cannot be saved",
            `Can't save ${labelOf(def.name)}: its schema did not turn one into plain data.`
          );
        }
        return data.value;
      });
      const read: Record<string, number> = {};
      for (const [reader, at] of readers) {
        if (at > base) {
          read[reader] = Math.min(at - base, values.length);
        }
      }
      out.push({ name: def.name, waiting, read });
    }
    return out.length === 0 ? undefined : out;
  }

  load(data: unknown): void {
    const saved = Schema.decodeUnknownExit(SavedWaiting)(data);
    if (Exit.isFailure(saved)) {
      throw new SnapshotError(
        "corrupt",
        `The snapshot is damaged: the events waiting to be read are not each { name, waiting, read }.`
      );
    }
    for (const { name, read, waiting } of saved.value) {
      const def = this.names.get(name) ?? defined.get(name);
      if (def === undefined) {
        throw new SnapshotError(
          "store changed",
          `The snapshot holds ${waiting.length === 1 ? "an event" : `${waiting.length} events`} named "${name}" waiting to be read, which this program doesn't define: it was renamed or removed since.`
        );
      }
      const channel = this.channel(def);
      for (const one of waiting) {
        const payload = decode(def, one);
        if (Exit.isFailure(payload)) {
          throw new SnapshotError(
            "store changed",
            `Can't load ${labelOf(name)}: one is in a form that is no longer taken: ${describeFailure(payload.cause)}`
          );
        }
        channel.values.push(payload.value);
      }
      // Whoever had read some of them goes on from where it was.
      for (const [reader, count] of Object.entries(read)) {
        channel.readers.set(
          reader,
          channel.base + Math.min(count, channel.values.length)
        );
      }
    }
  }

  hashed(): unknown {
    const held = this.held();
    if (held.length === 0) {
      return undefined;
    }
    return held.map(({ def, values }) => [
      def.name,
      values.map((payload) => {
        // A payload its schema refuses counts as null, on every machine
        // alike: nothing checks what is emitted, and a hash doesn't fail.
        const data = encode(def, payload);
        return Exit.isFailure(data) ? null : data.value;
      }),
    ]);
  }

  capture(): WaitingMoment {
    return {
      channels: this.order.map((channel) => ({
        channel,
        values: channel.values.slice(),
        base: channel.base,
        readers: new Map(channel.readers),
      })),
      emitted: this.emitted.slice(),
    };
  }

  rewind(moment: WaitingMoment): void {
    for (const { base, channel, readers, values } of moment.channels) {
      channel.values = values.slice();
      channel.base = base;
      for (const [reader, at] of readers) {
        channel.readers.set(reader, at);
      }
    }
    this.emitted = moment.emitted.slice();
  }

  clear(): void {
    for (const channel of this.order) {
      channel.values = [];
      channel.base = 0;
      channel.readers.clear();
    }
    this.emitted = [];
  }

  begin(): void {
    this.recording = true;
    this.emittedMark = this.emitted.length;
    for (const channel of this.order) {
      channel.txEnd = channel.end;
    }
  }

  rollback(): void {
    for (const channel of this.order) {
      // A channel first used in the transaction held nothing before it.
      channel.values.length = Math.max(0, channel.txEnd - channel.base);
    }
    // Newest first, so that a reader that read twice ends where it began.
    const { moved } = this;
    for (let i = moved.length - 1; i >= 0; i--) {
      const { at, channel, reader } = moved[i]!;
      if (at === undefined) {
        channel.readers.delete(reader);
      } else {
        channel.readers.set(reader, at);
      }
    }
    this.emitted.length = this.emittedMark;
    this.commit();
  }

  commit(): void {
    this.recording = false;
    this.moved.length = 0;
  }

  contents(): unknown {
    const held = this.hashed() as [string, unknown[]][] | undefined;
    return held === undefined ? undefined : Object.fromEntries(held);
  }
}

// ---------------------------------------------------------------------------
// The other side: what the stages between ticks hear
// ---------------------------------------------------------------------------

/**
 * How many ticks events are kept for a stage between ticks that has stopped
 * running, or never ran, before it is taken to be gone: ten seconds at 60 Hz.
 * A replay and a server run neither stage.
 */
const PATIENCE = 600;

/**
 * What one run of the game's code emitted: a tick, an action dispatched
 * between two ticks, a plugin's setup. Each points at the one told after it,
 * and whoever reads holds the last one it has read: what nobody holds any
 * more is forgotten with no bookkeeping.
 *
 * Opaque: a moment of a game holds the last one told, for a rewind.
 *
 * @internal
 */
export interface Told {
  /** Its place among all that were told. No two have the same. */
  readonly seq: number;
  /** The tick it is of: an action applied between two ticks is of the next. */
  readonly tick: number;
  readonly events: readonly Emitted[];
  next: Told | undefined;
  /** True once a rewind has given it up: nothing is told after it any more. */
  dead: boolean;
}

/** One of the two stages between ticks. */
type Stage = "frame" | "input";

/** A place in what was told, of one event: a system of a stage, or outside code. */
class Listener<P> implements EventHandle<P> {
  private readonly heard: Heard;
  readonly def: EventDef<P>;
  /** The stage it is a system of, or undefined for outside code. */
  readonly stage: Stage | undefined;
  /** The last it has read. */
  after: Told;
  /**
   * After a rewind to run ticks again, the events it had heard of them, by
   * tick: as a tick emits one of them again, it is taken out here and not
   * heard twice.
   */
  echo: Map<number, P[]> | undefined;

  /** For outside code: how many times the game had gone back when it last read. */
  rewinds: number;

  constructor(
    heard: Heard,
    def: EventDef<P>,
    stage: Stage | undefined,
    after: Told
  ) {
    this.rewinds = heard.rewinds;
    this.heard = heard;
    this.def = def;
    this.stage = stage;
    this.after = after;
  }

  emit(): void {
    throw new Error(
      `The event "${this.def.name}" was emitted in the frame stage or the input stage. They run between ticks and must not change the game: an event from there would be one no replay could repeat. Emit from a system that runs in the tick, or issue an action with Actions.enqueue.`
    );
  }

  readonly read = (): readonly P[] => this.heard.read(this);
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
 * What the frame stage, the input stage and outside code hear of a game: the
 * events its ticks emitted, in the order they were told. It is not the
 * game's. No snapshot holds it and the hash doesn't cover it, and a rewind
 * doesn't put it back: what a stage heard, it heard.
 */
class Heard {
  private seq = 0;
  /** How many times the game went back. */
  rewinds = 0;
  /** The last that was told. */
  private tail: Told = {
    seq: 0,
    tick: 0,
    events: EMPTY,
    next: undefined,
    dead: false,
  };
  /**
   * For each stage that has systems: the last it had been told when it last
   * ran, and the tick it ran after. A system of the stage that asks for an
   * event for the first time starts from there.
   */
  private readonly seen = new Map<Stage, { told: Told; tick: number }>();
  /** The systems of the stages that listen, by system and event. */
  private readonly listeners = new Map<
    string,
    Map<object, Listener<unknown>>
  >();
  /** What was told since the last tick ended. */
  private since: Emitted[] = [];
  /** What was told from the end of the tick before the last to the end of the last. */
  private last: Record<string, readonly unknown[]> = {};

  /**
   * Told once which of the two stages an app has systems in: events are kept
   * for those from now on, so that such a system hears the events of the
   * ticks before it first ran.
   */
  expect(stage: Stage, tick: number): void {
    this.seen.set(stage, { told: this.tail, tick });
  }

  /** Tells what one run of the game's code emitted, for the tick it is of. */
  tell(tick: number, events: readonly Emitted[]): void {
    if (events.length === 0) {
      return;
    }
    const told: Told = {
      seq: ++this.seq,
      tick,
      events,
      next: undefined,
      dead: false,
    };
    this.tail.next = told;
    this.tail = told;
    for (const event of events) {
      this.since.push(event);
    }
  }

  /** A tick has ended. */
  ticked(tick: number): void {
    const last: Record<string, unknown[]> = {};
    for (const { def, payload } of this.since) {
      (last[def.name] ??= []).push(payload);
    }
    this.last = last;
    this.since = [];
    // A stage that has not run for a long time is taken to be gone.
    for (const [stage, seen] of this.seen) {
      if (tick - seen.tick > PATIENCE && seen.told !== this.tail) {
        this.pass(stage, seen.tick);
      }
    }
  }

  /** A stage has run: its systems have had their chance at everything told. */
  ended(stage: Stage, tick: number): void {
    this.pass(stage, tick);
  }

  private pass(stage: Stage, tick: number): void {
    this.seen.set(stage, { told: this.tail, tick });
    for (const listener of this.each()) {
      if (listener.stage === stage) {
        listener.after = this.tail;
      }
    }
  }

  private *each(): Generator<Listener<unknown>> {
    for (const mine of this.listeners.values()) {
      yield* mine.values();
    }
  }

  /** The place of a system of a stage in one event: always the same one. */
  listener<P>(system: string, def: EventDef<P>, stage: Stage): Listener<P> {
    let mine = this.listeners.get(system);
    if (mine === undefined) {
      mine = new Map();
      this.listeners.set(system, mine);
    }
    let listener = mine.get(def) as Listener<P> | undefined;
    if (listener === undefined) {
      listener = new Listener(
        this,
        def,
        stage,
        this.seen.get(stage)?.told ?? this.tail
      );
      mine.set(def, listener as Listener<unknown>);
    }
    return listener;
  }

  /** A place for outside code, which hears what is told from now on. */
  outside<P>(def: EventDef<P>): Listener<P> {
    return new Listener(this, def, undefined, this.tail);
  }

  read<P>(listener: Listener<P>): readonly P[] {
    // Outside code, which nothing keeps track of, hears what is told from a
    // rewind on. A system of a stage was moved by the rewind.
    if (listener.stage === undefined && listener.rewinds !== this.rewinds) {
      listener.rewinds = this.rewinds;
      listener.after = this.tail;
    }
    let told = listener.after;
    if (told.next === undefined) {
      listener.after = told;
      return EMPTY;
    }
    const out: P[] = [];
    while (told.next !== undefined) {
      told = told.next;
      const echo = listener.echo;
      if (echo !== undefined) {
        // The ticks run again come in order: what it heard of an earlier
        // one and was not emitted again will not be.
        for (const tick of echo.keys()) {
          if (tick < told.tick) {
            echo.delete(tick);
          }
        }
        if (echo.size === 0) {
          listener.echo = undefined;
        }
      }
      for (const { def, payload } of told.events) {
        if (def !== listener.def) {
          continue;
        }
        const before = listener.echo?.get(told.tick);
        const at =
          before === undefined
            ? -1
            : before.findIndex((was) => same(was, payload));
        if (at === -1) {
          out.push(payload as P);
        } else {
          before!.splice(at, 1);
        }
      }
    }
    listener.after = told;
    return out.length === 0 ? EMPTY : out;
  }

  /** The last that was told: where a moment of the game is, in what was told. */
  mark(): Told {
    return this.tail;
  }

  /**
   * The game went back to where `to` was the last told. What was told after
   * it is given up.
   *
   * With `again`, the game goes back to run the same ticks again, as a
   * session does when a peer's actions arrive late: what a system of a stage
   * had heard of those ticks, it doesn't hear a second time when they emit
   * it again, and only what they now do otherwise is new to it. Without, the
   * game goes on from there as a new one would, and every event is new.
   */
  rewound(to: Told, again: boolean): void {
    this.rewinds++;
    this.since = [];
    this.last = {};
    const first = to.dead ? undefined : to.next;
    for (let told = first; told !== undefined; told = told.next) {
      told.dead = true;
    }
    // A moment of a future that was itself given up leads nowhere any more:
    // everyone starts from it.
    const moved = (at: Told): boolean => to.dead || at.seq > to.seq;
    for (const listener of this.each()) {
      if (!moved(listener.after)) {
        continue;
      }
      if (again) {
        for (
          let told = first;
          told !== undefined && told.seq <= listener.after.seq;
          told = told.next
        ) {
          for (const { def, payload } of told.events) {
            if (def === listener.def) {
              listener.echo ??= new Map();
              const before = listener.echo.get(told.tick);
              if (before === undefined) {
                listener.echo.set(told.tick, [payload]);
              } else {
                before.push(payload);
              }
            }
          }
        }
      }
      listener.after = to;
    }
    for (const seen of this.seen.values()) {
      if (moved(seen.told)) {
        seen.told = to;
      }
    }
    to.dead = false;
    to.next = undefined;
    this.tail = to;
  }

  /**
   * The events told in the last tick, and between it and the one before, by
   * event name, in the order they were emitted.
   */
  lastTick(): Record<string, readonly unknown[]> {
    return this.last;
  }
}

// ---------------------------------------------------------------------------
// The bus: what a game and an app are given
// ---------------------------------------------------------------------------

/**
 * Where an app's events are emitted and read. The app holds one; a game
 * reads and emits through an `EventHandle`.
 *
 * @category Models
 */
export class EventBus {
  /**
   * Who is asking for handles right now. The app sets this before each
   * system and handler runs, which is what gives each of them its own
   * place in the events. Undefined means outside code.
   * @internal
   */
  reader: string | undefined;
  /**
   * The stage between ticks that is running, if one is. Its systems read
   * what was told and can't emit.
   * @internal
   */
  stage: Stage | undefined;

  private readonly waiting: Waiting;
  private readonly heard = new Heard();
  /** The handles of the tick's systems and of handlers, by reader and event. */
  private readonly handles = new Map<
    string,
    Map<object, EventHandle<unknown>>
  >();

  /** Keeps the events the simulation has yet to read in `world`, as a store. */
  constructor(world: World) {
    this.waiting = new Waiting(world);
    world._attach(this.waiting);
  }

  /**
   * Returns a handle for whoever is running. A system and a handler get the
   * same handle every time. A system of the tick and a handler read from the
   * oldest event still kept; a system of the frame stage or the input stage
   * reads what the ticks emitted since its stage last ran, and can't emit.
   * Any other caller gets a new handle, which reads what is emitted once
   * the code that emits it has ended, from now on.
   */
  handle<P>(def: EventDef<P>): EventHandle<P> {
    const channel = this.waiting.channel(def);
    const { reader, stage, waiting } = this;
    if (reader === undefined) {
      const listener = this.heard.outside(def);
      return {
        emit: (payload) => {
          waiting.emit(channel, payload);
        },
        read: listener.read,
      };
    }
    if (stage !== undefined) {
      return this.heard.listener(reader, def, stage);
    }
    let mine = this.handles.get(reader);
    if (mine === undefined) {
      mine = new Map();
      this.handles.set(reader, mine);
    }
    let handle = mine.get(def) as EventHandle<P> | undefined;
    if (handle === undefined) {
      handle = {
        emit: (payload) => {
          waiting.emit(channel, payload);
        },
        read: () => waiting.read(channel, reader),
      };
      mine.set(def, handle as EventHandle<unknown>);
    }
    return handle;
  }

  /**
   * Emits from outside any system, between ticks, for example from a test.
   * It throws while the frame stage or the input stage runs.
   */
  emit<P>(def: EventDef<P>, payload: P): void {
    this.waiting.emit(this.waiting.channel(def), payload);
  }

  /** Returns the number of events of a type the tick can still read. For tests and tooling. */
  pending<P>(def: EventDef<P>): number {
    return this.waiting.channel(def).values.length;
  }

  /**
   * Whether an event is kept that some system of the tick has not had its
   * chance at: one emitted by a system, which the systems before it hear
   * in the tick that follows, or one emitted between ticks.
   * @internal
   */
  settled(): boolean {
    return !this.waiting.waiting();
  }

  /**
   * The events emitted in the last tick, and between it and the one before,
   * by event name, in the order they were emitted: for `app.inspect`.
   * @internal
   */
  lastTick(): Record<string, readonly unknown[]> {
    return this.heard.lastTick();
  }

  /**
   * Told once, by the app, that it has systems in a stage between ticks:
   * events are kept for them from the first tick on.
   * @internal
   */
  expect(stage: Stage, tick: number): void {
    this.heard.expect(stage, tick);
  }

  /**
   * Called just before a tick's systems run: what is emitted from here on is
   * kept until the end of the tick after this one.
   * @internal
   */
  open(): void {
    this.waiting.open();
  }

  /**
   * Called when tick `tick` has run: drops the events every system has had
   * its chance to read, and tells the stages between ticks what it emitted.
   * @internal
   */
  close(tick: number): void {
    this.waiting.close();
    this.told(tick);
    this.heard.ticked(tick);
  }

  /**
   * Called when the game's code has run between two ticks, an action's
   * handler or a plugin's setup: tells the stages what it emitted, as of the
   * tick to come, `tick`.
   * @internal
   */
  told(tick: number): void {
    this.heard.tell(tick, this.waiting.take());
  }

  /**
   * Called when a stage between ticks has run, after tick `tick`: its
   * systems have had their chance at every event there is.
   * @internal
   */
  ended(stage: Stage, tick: number): void {
    this.heard.ended(stage, tick);
  }

  /**
   * Where the game is in what the stages between ticks were told, for a
   * moment of it to hold.
   * @internal
   */
  mark(): Told {
    return this.heard.mark();
  }

  /**
   * Called when the game has gone back to a moment, with what `mark` gave
   * for it. With `again`, it went back to run the same ticks again, and the
   * stages don't hear twice what they heard of them.
   * @internal
   */
  rewound(to: Told, again: boolean): void {
    this.heard.rewound(to, again);
  }
}
