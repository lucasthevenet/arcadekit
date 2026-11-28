import { Brand } from "effect";

import type * as Action from "../Action.ts";
import { add, finish } from "../ecs/hash.ts";
import type { Store } from "../ecs/store.ts";
import type { World } from "../ecs/world.ts";
import type { Origin, Recording } from "../Replay.ts";
import type * as Save from "../Save.ts";
import { singleton } from "./save.ts";
import { GameTime } from "./stage.ts";

/** @internal Brands what a recording holds as one. */
export const recorded = Brand.nominal<Recording>();

/** @internal The tick a save was made at, which its world holds. */
export const tickOf = (save: Save.Save): number => {
  const tick = singleton(save, GameTime.component.name, "tick");
  return typeof tick === "number" ? tick : 0;
};

/**
 * A save as what it holds: its version, and its world's length and hash. A
 * copy read back from its bytes is the same save.
 */
const keyOf = ({ version, world }: Save.Save): string => {
  const view = new DataView(world.buffer, world.byteOffset, world.byteLength);
  const words = world.length >>> 2;
  let hash = 0;
  for (let i = 0; i < words; i++) {
    hash = add(hash, view.getInt32(i * 4, true));
  }
  for (let i = words * 4; i < world.length; i++) {
    hash = add(hash, world[i]!);
  }
  return `${version} ${world.length} ${finish(hash)}`;
};

/** An entry of the log, with what became of it once it was applied. */
interface Fated {
  refused?: string;
}

/**
 * One change of a log: an entry logged, what became of an entry once it was
 * applied, with what it was before, or a run of deltas begun. Each points at
 * the change before it, so that the log of every moment a game was at is a
 * path back from its last change: a rewind undoes the changes back to where
 * the two paths meet, and does again those of the moment's own.
 */
interface Change {
  readonly step:
    | { readonly entry: Action.LogEntry }
    | {
        readonly fated: Fated;
        readonly refused: string;
        readonly was: string | undefined;
      }
    | { readonly run: { readonly tick: number; readonly delta: number } }
    | undefined;
  readonly before: Change | undefined;
  /** How many changes lead to it. */
  readonly depth: number;
  /** The tick it was made at. */
  readonly tick: number;
}

/** Where a log begins. */
const begun = (tick: number): Change => ({
  step: undefined,
  before: undefined,
  depth: 0,
  tick,
});

/**
 * A place in a log: a tick, and the length the log had then, which is what a
 * moment of a game holds of its log, and where a save of it was taken.
 *
 * @internal
 */
export interface Since {
  readonly tick: number;
  readonly logLength: number;
  /** The log's last change, from which a rewind finds its way there. */
  readonly last: Change;
  /** How many saves the app had loaded in place. */
  readonly loads: number;
}

/**
 * The log an app keeps of its game: what entered it from outside, the
 * hash checks of its world's hash, how long each tick was, and where each
 * save of the game was taken, to record what came since. It is about
 * the run and not the game, so no snapshot holds it and the hash doesn't
 * cover it. It is a store of the app's world all the same, for one thing: a
 * rewind takes it back to the length it had, with the world.
 *
 * @internal
 */
export class Log implements Store<Since> {
  readonly name = "arcadekit/log";
  // What comes from outside is logged as it arrives, between ticks too.
  readonly betweenTicks = true;
  /** What `app.actionLog` is. */
  readonly entries: Action.LogEntry[] = [];
  /** The number of ticks the game had run when its app was made, or last loaded a save. */
  private began: number;
  /** The delta of every tick run since, in runs of ticks that took the same. */
  private readonly deltas: { tick: number; delta: number }[] = [];
  /** Its last change. */
  private last: Change;
  private readonly world: World;
  private readonly time: { readonly tick: number };
  private readonly hashEvery: number;
  /** How the game began when its app was made, or last loaded a save. */
  private origin: Origin;
  /**
   * Where each save of its game was taken, by `keyOf` the save: a place for
   * each way the game came to it.
   */
  private readonly saves = new Map<string, Since[]>();
  /**
   * How many saves the app has loaded in place. A moment of its game holds
   * it: one taken before a load is of a game the log no longer follows.
   */
  loads = 0;

  /** `given` is the save the app was made from, before its migrations. */
  constructor(
    world: World,
    time: { readonly tick: number },
    hashEvery: number,
    origin: Origin,
    given?: Save.Save
  ) {
    if (!Number.isSafeInteger(hashEvery) || hashEvery < 0) {
      throw new Error(
        `hashEvery must be a whole number of ticks, 0 for none, and this one is ${hashEvery}.`
      );
    }
    this.world = world;
    this.time = time;
    this.began = time.tick;
    this.last = begun(time.tick);
    this.hashEvery = hashEvery;
    this.origin = origin;
    this.startsFrom(given);
  }

  /** Holds that the log begins at the save it began from, given or loaded. */
  private startsFrom(given: Save.Save | undefined): void {
    this.saves.clear();
    for (const save of [given, this.origin.save]) {
      if (save !== undefined) {
        this.saved(save);
      }
    }
  }

  /**
   * Starts the log over at a save the app has just loaded in place, as the log
   * of an app made from it would start.
   */
  restart(loaded: Save.Save, given: Save.Save): void {
    this.last = begun(this.time.tick);
    this.entries.length = 0;
    this.deltas.length = 0;
    this.began = this.time.tick;
    this.origin = { save: loaded };
    this.startsFrom(given);
    this.loads++;
  }

  /** Holds that a save of its game was taken here. */
  saved(save: Save.Save): void {
    const key = keyOf(save);
    const places = this.saves.get(key) ?? [];
    if (!places.some((place) => this.reaches(place))) {
      places.push(this.capture());
      this.saves.set(key, places);
    }
  }

  /**
   * Whether the game stands at a place or after it: the place's last change is
   * on the log's path, and nothing was logged after it before the place's
   * tick. The ticks between two changes run alike whichever way the game came
   * to them, so a game rewound to before a save and ticked on, with nothing
   * logged, comes to the save again.
   */
  private reaches({ last, tick }: Since): boolean {
    let change = this.last;
    let next: Change | undefined;
    while (change.depth > last.depth) {
      next = change;
      change = change.before!;
    }
    return change === last && (next?.tick ?? this.time.tick) >= tick;
  }

  /** Makes a change, the last from now on. */
  private change(step: Change["step"]): void {
    this.last = {
      step,
      before: this.last,
      depth: this.last.depth + 1,
      tick: this.time.tick,
    };
  }

  /** Logs an entry. */
  private log(entry: Action.LogEntry): void {
    this.entries.push(entry);
    this.change({ entry });
  }

  /** Records the world's hash now, and returns it. */
  hashCheck(): number {
    const hash = this.world._fullHash();
    this.log({ tick: this.time.tick, hash });
    return hash;
  }

  /** Says of an enqueued action's entry that the tick that applied it refused it. */
  refused(entry: { refused?: string }, reason: string): void {
    const was = entry.refused;
    entry.refused = reason;
    this.change({ fated: entry, refused: reason, was });
  }

  /**
   * Called before the first action is applied and before the first tick
   * runs. The state the game starts from is whatever the world holds then:
   * setup and the caller have spawned what they spawn by then, and a replay
   * checks it has the same. A game has started once its log holds anything:
   * a hash check the game took by hand before starting already is the first.
   */
  start(): void {
    if (this.hashEvery > 0 && this.entries.length === 0) {
      this.hashCheck();
    }
  }

  /**
   * Logs an action enqueued from outside as it arrives, and returns its
   * entry. Its outcome is decided when it is applied, and a replay enqueues
   * it again at the same point and lets its own simulation decide.
   */
  arrived(
    name: string,
    payload: unknown,
    from: string | undefined
  ): { refused?: string } {
    this.start();
    const entry: {
      readonly tick: number;
      readonly name: string;
      readonly payload: unknown;
      readonly from?: string;
      readonly queued: true;
      refused?: string;
    } = {
      tick: this.time.tick,
      name,
      payload,
      ...(from === undefined ? {} : { from }),
      queued: true,
    };
    this.log(entry);
    return entry;
  }

  /** Logs an action that was dispatched and accepted. */
  accepted(name: string, payload: unknown, from: string | undefined): void {
    this.log({
      tick: this.time.tick,
      name,
      payload,
      ...(from === undefined ? {} : { from }),
    });
  }

  /** A tick is about to run, and takes `delta`. Before the time moves. */
  ticking(delta: number): void {
    if (this.deltas.at(-1)?.delta !== delta) {
      const run = { tick: this.time.tick, delta };
      this.deltas.push(run);
      this.change({ run });
    }
  }

  /** A tick has run: a hash check, if one is due. */
  ticked(): void {
    const { hashEvery } = this;
    if (hashEvery > 0 && this.time.tick % hashEvery === 0) {
      this.hashCheck();
    }
  }

  // --- what the world asks of a store: only to go back with it -----------------

  save(): unknown {
    return undefined;
  }

  load(): void {}

  hashed(): unknown {
    return undefined;
  }

  capture(): Since {
    return {
      tick: this.time.tick,
      logLength: this.entries.length,
      last: this.last,
      loads: this.loads,
    };
  }

  /**
   * Why the log can't go with the game to a place, or undefined when it can:
   * one of the game the app had before it last loaded a save.
   */
  refuses(since: Since): string | undefined {
    return since.loads === this.loads
      ? undefined
      : "captured before the app loaded a save, of the game the load replaced. To go back there, save that game and load the save.";
  }

  /**
   * Puts the log as it was at a place, whichever way the game went since:
   * back, or to a future it had given up. What became of each entry goes
   * with it, so an action that waits again there has had nothing become of
   * it yet.
   */
  rewind(since: Since): void {
    const { deltas, entries } = this;
    let from = this.last;
    let to = since.last;
    const again: Change[] = [];
    const undo = (change: Change): Change => {
      const { step } = change;
      if (step === undefined) {
        throw new Error("A log was rewound past where it began.");
      }
      if ("entry" in step) {
        entries.pop();
      } else if ("run" in step) {
        deltas.pop();
      } else if (step.was === undefined) {
        delete step.fated.refused;
      } else {
        step.fated.refused = step.was;
      }
      return change.before!;
    };
    while (to.depth > from.depth) {
      again.push(to);
      to = to.before!;
    }
    while (from.depth > to.depth) {
      from = undo(from);
    }
    while (from !== to) {
      from = undo(from);
      again.push(to);
      to = to.before!;
    }
    for (let i = again.length - 1; i >= 0; i--) {
      const { step } = again[i]!;
      if (step === undefined) {
        continue;
      }
      if ("entry" in step) {
        entries.push(step.entry);
      } else if ("run" in step) {
        deltas.push(step.run);
      } else {
        step.fated.refused = step.refused;
      }
    }
    this.last = since.last;
  }

  // Not the snapshot's to empty: a world that is restored keeps its log.
  clear(): void {}

  begin(): void {}

  rollback(): void {}

  commit(): void {}

  contents(): unknown {
    return undefined;
  }

  /** The game as it was played: all of it, or what came since a save of it. */
  record(since: Save.Save | undefined): Recording {
    const { began, deltas, entries, time } = this;
    const { logLength, tick: start } =
      since === undefined ? { logLength: 0, tick: began } : this.placeOf(since);
    // The run that was under way at the start begins there.
    let first = 0;
    while (first + 1 < deltas.length && deltas[first + 1]!.tick <= start) {
      first++;
    }
    return recorded({
      ...(since === undefined ? this.origin : { save: since }),
      start,
      end: time.tick,
      endHash: this.world._fullHash(),
      deltas:
        start === time.tick
          ? []
          : deltas.slice(first).map((run, i) => ({
              tick: i === 0 ? start : run.tick,
              delta: run.delta,
            })),
      // Copies: an enqueued action's entry is told its fate later.
      log: entries.slice(logLength).map((entry) => ({ ...entry })),
    });
  }

  /**
   * Where the game took a save it stands at or after. A save's bytes come
   * from outside, and its key is a hash of 32 bits, so the tick its world
   * holds is checked as well: bytes changed to give the same key can say
   * another tick.
   */
  private placeOf(save: Save.Save): Since {
    const place = this.saves
      .get(keyOf(save))
      ?.find((place) => this.reaches(place));
    if (place === undefined || tickOf(save) !== place.tick) {
      throw new Error(
        "Replay.record() was given a save that this app didn't make, or that its log no longer reaches: the app loaded a save since, or the game went back to before the save and came to it again past a move, as a session's rollback does. Record since a save it made or began from, as Save.make gave it or read back from its bytes, or record all of it."
      );
    }
    return place;
  }
}
