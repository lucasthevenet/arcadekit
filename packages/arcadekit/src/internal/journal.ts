import { Brand } from "effect";

import type * as Action from "../Action.ts";
import type { Store } from "../ecs/store.ts";
import type { World } from "../ecs/world.ts";
import type { Origin, Recording } from "../Journal.ts";
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
 * A place in a log: a tick, and the length the log had then. Where a
 * recording begins when it is made since a save, and what a moment of a
 * game holds of its log.
 *
 * @internal
 */
export interface Since {
  readonly tick: number;
  readonly logLength: number;
}

/**
 * The log an app keeps of its game: what entered it from outside, the
 * checkpoints of its world's hash, and how long each tick was. It is about
 * the run and not the game, so no snapshot holds it and the hash doesn't
 * cover it. It is a store of the app's world all the same, for one thing: a
 * rewind takes it back to the length it had, with the world.
 *
 * @internal
 */
export class Log implements Store<Since> {
  readonly name = "arcadekit/journal";
  // What comes from outside is logged as it arrives, between ticks too.
  readonly betweenTicks = true;
  /** What `app.actionLog` is. */
  readonly entries: Action.LogEntry[] = [];
  /** The number of ticks the game had run when its app was made. */
  private readonly began: number;
  /** The delta of every tick run since, in runs of ticks that took the same. */
  private readonly deltas: { tick: number; delta: number }[] = [];
  private readonly world: World;
  private readonly time: { readonly tick: number };
  private readonly checkpointEvery: number;
  /** How the game began when its app was made. */
  private readonly origin: Origin;

  constructor(
    world: World,
    time: { readonly tick: number },
    checkpointEvery: number,
    origin: Origin
  ) {
    if (!Number.isSafeInteger(checkpointEvery) || checkpointEvery < 0) {
      throw new Error(
        `checkpointEvery must be a whole number of ticks, 0 for none, and this one is ${checkpointEvery}.`
      );
    }
    this.world = world;
    this.time = time;
    this.began = time.tick;
    this.checkpointEvery = checkpointEvery;
    this.origin = origin;
  }

  /** Records the world's hash now, and returns it. */
  checkpoint(): number {
    const hash = this.world._fullHash();
    this.entries.push({ tick: this.time.tick, hash });
    return hash;
  }

  /**
   * Called before the first action is applied and before the first tick
   * runs. The state the game starts from is whatever the world holds then:
   * setup and the caller have spawned what they spawn by then, and a replay
   * checks it has the same. A game has started once its log holds anything:
   * a checkpoint the game took by hand before starting already is the first.
   */
  start(): void {
    if (this.checkpointEvery > 0 && this.entries.length === 0) {
      this.checkpoint();
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
    this.entries.push(entry);
    return entry;
  }

  /** Logs an action that was dispatched and accepted. */
  accepted(name: string, payload: unknown, from: string | undefined): void {
    this.entries.push({
      tick: this.time.tick,
      name,
      payload,
      ...(from === undefined ? {} : { from }),
    });
  }

  /** A tick is about to run, and takes `delta`. Before the time moves. */
  ticking(delta: number): void {
    if (this.deltas.at(-1)?.delta !== delta) {
      this.deltas.push({ tick: this.time.tick, delta });
    }
  }

  /** A tick has run: a checkpoint, if one is due. */
  ticked(): void {
    const { checkpointEvery } = this;
    if (checkpointEvery > 0 && this.time.tick % checkpointEvery === 0) {
      this.checkpoint();
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
    return { tick: this.time.tick, logLength: this.entries.length };
  }

  /** Takes the log back to the length it had when the game was at a tick. */
  rewind({ logLength, tick }: Since): void {
    this.entries.length = logLength;
    while ((this.deltas.at(-1)?.tick ?? -1) >= tick) {
      this.deltas.pop();
    }
  }

  // Not the snapshot's to empty: a world that is restored keeps its log.
  clear(): void {}

  begin(): void {}

  rollback(): void {}

  commit(): void {}

  contents(): unknown {
    return undefined;
  }

  /** The game as it was played: all of it, or what came since a save. */
  record(since: Save.Save | undefined): Recording {
    const { began, deltas, entries, time } = this;
    const start = since === undefined ? began : tickOf(since);
    const from = since?.logLength ?? 0;
    if (
      start < began ||
      start > time.tick ||
      from > entries.length ||
      (entries[from - 1]?.tick ?? start) > start ||
      (entries[from]?.tick ?? start) < start
    ) {
      throw new Error(
        `record() was given a save of tick ${start} that this app didn't make: its log doesn't reach it there. Record since a save of this app, or record all of it.`
      );
    }
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
      log: entries.slice(from).map((entry) => ({ ...entry })),
    });
  }
}
