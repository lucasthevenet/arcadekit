/**
 * A game's outbox holds the events its ticks emitted, in the order they were
 * emitted, for the frame stage, the input stage and outside code to read.
 * Sound and a UI follow a game through it.
 *
 * The outbox is the other side of `Event`. The events the simulation has yet
 * to read belong to the game, and its world holds them. What the outbox has
 * sent out doesn't. No snapshot holds it, the hash doesn't cover it, and a
 * rewind doesn't take it back. After a game goes back and plays on, its events
 * are heard afresh. After a session takes a game back to run the same ticks
 * again, each event of those ticks is heard once.
 */
import type { Emitted, EventDef, EventHandle } from "./Event";

const EMPTY: readonly never[] = Object.freeze([]);

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

/**
 * One of the two stages between ticks.
 *
 * @category Models
 */
export type Stage = "frame" | "input";

/**
 * A reader's place in what the outbox has told of one event. The reader is a
 * system of a stage between ticks, or outside code. It reads, and can't emit.
 *
 * @category Models
 */
export class Listener<P> implements EventHandle<P> {
  private readonly outbox: Outbox;
  readonly def: EventDef<P>;
  /** The stage it is a system of, or undefined for outside code. */
  readonly stage: Stage | undefined;
  /** The last of what was told that it has read. */
  after: Told;
  /**
   * After a rewind to run the same ticks again, the events it had heard of
   * them, by tick. When a tick emits one of them again, it is taken out of
   * here and isn't heard twice.
   */
  echo: Map<number, P[]> | undefined;

  /** For outside code: how many times the game had gone back when it last read. */
  rewinds: number;

  constructor(
    outbox: Outbox,
    def: EventDef<P>,
    stage: Stage | undefined,
    after: Told
  ) {
    this.rewinds = outbox.rewinds;
    this.outbox = outbox;
    this.def = def;
    this.stage = stage;
    this.after = after;
  }

  emit(): void {
    throw new Error(
      `The event "${this.def.name}" was emitted in the frame stage or the input stage. They run between ticks and must not change the game: an event from there would be one no replay could repeat. Emit from a system that runs in the tick, or issue an action with Actions.enqueue.`
    );
  }

  readonly read = (): readonly P[] => this.outbox.read(this);
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
 * The events a game's ticks emitted, in order, sent out for the frame stage,
 * the input stage and outside code to read. It doesn't belong to the game. No
 * snapshot holds it, the hash doesn't cover it, and a rewind doesn't take back
 * what a stage has heard.
 *
 * @category Models
 */
export class Outbox {
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
   * Keeps events from now on for a stage that the app has systems in, so that
   * such a system hears the events of the ticks before it first ran. An app
   * calls it once for each such stage.
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

  /**
   * Marks the end of a tick. A stage that hasn't run for more than 600 ticks,
   * ten seconds at 60 Hz, is taken to be gone, and its systems skip what was
   * told before.
   */
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

  /** Marks that a stage has run, and moves its systems past everything told. */
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

  /**
   * Returns the place of a system of a stage in one event, the same one each
   * time.
   */
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

  /** Returns a place for outside code, which hears what is told from now on. */
  outside<P>(def: EventDef<P>): Listener<P> {
    return new Listener(this, def, undefined, this.tail);
  }

  /** Returns what was told of a listener's event since it last read. */
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

  /**
   * Returns the last that was told, which is where a moment of the game is in
   * what was told.
   */
  mark(): Told {
    return this.tail;
  }

  /**
   * Takes the outbox back to where `to` was the last told, after the game went
   * back. What was told after it is given up.
   *
   * With `again`, the game goes back to run the same ticks again, as a session
   * does when a peer's actions arrive late. A system of a stage doesn't hear a
   * second time what it had heard of those ticks, and hears only what they now
   * do differently. Without `again`, the game goes on from there as a new one
   * would, and every event is new.
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
   * Returns the events told in the last tick, and between it and the one
   * before, by event name, in the order they were emitted.
   */
  lastTick(): Record<string, readonly unknown[]> {
    return this.last;
  }
}
