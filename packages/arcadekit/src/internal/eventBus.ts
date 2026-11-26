import { Cause, Exit, Schema } from "effect";

import { SnapshotError } from "../ecs/snapshot.ts";
import type { WithSpawned } from "../ecs/spawned.ts";
import { isPlain } from "../ecs/store.ts";
import type { Store } from "../ecs/store.ts";
import type { World } from "../ecs/world.ts";
import { STORE, decode, encode } from "../Event.ts";
import type {
  EventDef,
  EventHandle,
  InvalidEvent,
  ReadingEvents,
} from "../Event.ts";
import { Outbox } from "./outbox.ts";
import type { Stage, Told } from "./outbox.ts";

/**
 * A payload as its readers get it: an event is read once the spawns of the
 * code that emitted it are applied, so an id it spawned is an entity by then.
 * The code that emitted it reads it on its next run, and other code once it
 * has ended, when its commands have been applied.
 */
const placedLater = <P>(payload: WithSpawned<P>): P => payload as P;

// Every event this program has defined, by name, so that an app can load a
// save that holds one it hasn't met yet. Of two definitions with one name, as
// a module that is loaded again under hot reload makes, it is the newer. An
// app that meets both refuses the second.
const defined = new Map<string, EventDef<unknown>>();

/** @internal Notes an event that was just defined, the newest of its name. */
export const defining = (def: EventDef<unknown>): void => {
  defined.set(def.name, def);
};

/** What an `InvalidEvent` says was wrong. */
const describeFailure = (cause: Cause.Cause<InvalidEvent>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

const EMPTY: readonly never[] = Object.freeze([]);

/**
 * One event as it was emitted, with which event it is.
 *
 * @internal
 */
export interface Emitted {
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
  /** The last run that emitted to it, by `Waiting`'s count. */
  emittedIn = -1;
  /** Where it ended when that run first emitted to it: what the run reads up to. */
  endBefore = 0;

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
  /**
   * Counts the runs of the game's code: each system, handler and setup that
   * runs begins one. What a run emits, it reads on its next: until it has
   * ended, the spawns of its commands are not applied, and an id a payload
   * holds is no entity yet.
   */
  private run = 0;
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
    if (channel.emittedIn !== this.run) {
      channel.emittedIn = this.run;
      channel.endBefore = channel.end;
    }
    channel.values.push(payload);
    this.emitted.push({ def: channel.def, payload });
  }

  /** Starts a run of the game's code: a system's, a handler's or a setup's. */
  startRun(): void {
    this.run += 1;
  }

  /**
   * What `reader` has yet to read, oldest first, which it has then read: what
   * was emitted before its run began.
   */
  read<P>(channel: Channel<P>, reader: string): readonly P[] {
    const { base, readers } = channel;
    const end =
      channel.emittedIn === this.run ? channel.endBefore : channel.end;
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
    return from === end ? EMPTY : channel.values.slice(from - base, end - base);
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

/** The refusal of an event emitted by code that is not the simulation's. */
const outside = (def: EventDef<unknown>): Error =>
  new Error(
    `The event "${def.name}" was emitted from outside the simulation. No log holds an event, so a replay of the game would not have it, and neither would another peer. Issue an action whose handler emits it, with app.enqueue or app.dispatch.`
  );

/**
 * Where an app's events are emitted and read. Each app holds one, which the
 * `Events` service provides. A game's code reads and emits through the
 * handles that `yield* SomeEvent` and `SomeEvent.emits` give.
 *
 * @internal
 */
export class EventBus implements ReadingEvents {
  /**
   * The stage between ticks that is running, if one is. Its systems read
   * what was told and can't emit.
   * @internal
   */
  stage: Stage | undefined;

  private running: string | undefined;
  private readonly waiting: Waiting;
  private readonly outbox = new Outbox();
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
   * The system or handler that is asking for handles, or undefined for code
   * outside the simulation. The app sets it before each one runs, and
   * setting it starts a run.
   * @internal
   */
  get reader(): string | undefined {
    return this.running;
  }

  set reader(reader: string | undefined) {
    this.running = reader;
    this.waiting.startRun();
  }

  /**
   * Returns a handle to an event type for the code that is running. A system
   * and a handler get the same handle every time. A system of the tick and a
   * handler read from the oldest event still kept. A system of the frame or
   * input stage reads what the ticks emitted since its stage last ran, and
   * can't emit. Any other caller gets a new handle, which reads each event
   * emitted from now on, once the code that emitted it has ended.
   */
  handle<P>(def: EventDef<P>): EventHandle<P> {
    const channel = this.waiting.channel(def);
    const { reader, stage, waiting } = this;
    if (reader === undefined) {
      const listener = this.outbox.outside(def);
      return {
        emit: (payload) => {
          this.emit(def, placedLater(payload));
        },
        read: listener.read,
      };
    }
    if (stage !== undefined) {
      return this.outbox.listener(reader, def, stage);
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
          // A handle kept and used once its system has run is outside code.
          if (this.reader === undefined) {
            throw outside(def);
          }
          waiting.emit(channel, placedLater(payload));
        },
        read: () => waiting.read(channel, reader),
      };
      mine.set(def, handle as EventHandle<unknown>);
    }
    return handle;
  }

  /**
   * Emits an event without a handle, from the code of the simulation: a
   * system, a handler or a plugin's setup. It throws when called from
   * anywhere else, since no log holds an event, and no replay or other peer
   * would have it. Code outside the simulation issues an action whose
   * handler emits the event.
   */
  emit<P>(def: EventDef<P>, payload: P): void {
    const channel = this.waiting.channel(def);
    if (this.reader === undefined) {
      throw outside(def);
    }
    this.waiting.emit(channel, payload);
  }

  /**
   * Emits an event of the app's own, in a tick, where no system or handler
   * is running: that a queued action was refused.
   * @internal
   */
  _emit<P>(def: EventDef<P>, payload: P): void {
    this.waiting.emit(this.waiting.channel(def), payload);
  }

  /**
   * Returns how many events of a type the tick can still read, for tests and
   * tools.
   */
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
    return this.outbox.lastTick();
  }

  /**
   * Told once, by the app, that it has systems in a stage between ticks:
   * events are kept for them from the first tick on.
   * @internal
   */
  expect(stage: Stage, tick: number): void {
    this.outbox.expect(stage, tick);
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
    this.outbox.ticked(tick);
  }

  /**
   * Called when the game's code has run between two ticks, an action's
   * handler or a plugin's setup: tells the stages what it emitted, as of the
   * tick to come, `tick`.
   * @internal
   */
  told(tick: number): void {
    this.outbox.tell(tick, this.waiting.take());
  }

  /**
   * Called when a stage between ticks has run, after tick `tick`: its
   * systems have had their chance at every event there is.
   * @internal
   */
  ended(stage: Stage, tick: number): void {
    this.outbox.ended(stage, tick);
  }

  /**
   * Where the game is in what the stages between ticks were told, for a
   * moment of it to hold.
   * @internal
   */
  mark(): Told {
    return this.outbox.mark();
  }

  /**
   * Called when the game has gone back to a moment, with what `mark` gave
   * for it. With `again`, it went back to run the same ticks again, and the
   * stages don't hear twice what they heard of them.
   * @internal
   */
  rewound(to: Told, again: boolean): void {
    this.outbox.rewound(to, again);
  }
}
