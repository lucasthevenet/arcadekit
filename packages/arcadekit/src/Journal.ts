/**
 * A game's journal: the log of what entered it from outside, with
 * checkpoints of its world's hash, the recording made of it, and the replay
 * that plays a recording again.
 *
 *   const recording = app.record()                 // the game so far
 *   const text = Journal.encode(recording)         // for a file or the network
 *
 *   const again = yield* App.make(sameOptions)
 *   Journal.replay(again, recording)               // the same game, checked
 *
 * An app keeps its journal as it plays: every action from outside the
 * simulation, a checkpoint of the world's hash at a regular interval of
 * ticks, and how long each tick was. A replay applies the log to a game made
 * the same way and stops at the first action or checkpoint that doesn't
 * match.
 */
import { Cause, Data, Exit, Schema } from "effect";

import * as Action from "./Action";
import type * as App from "./App";
import type { Store } from "./ecs/store";
import type { World } from "./ecs/world";

/** Summarizes an error in a few words, for a log entry or a message. */
const describe = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

const NO_INPUT = { input: false } as const;

/**
 * A game as it was played, from `app.record()`, for `Journal.replay` to play
 * again: everything it needs beside the game's own plugins and options.
 *
 * @category Models
 */
export interface Recording {
  /** The number of ticks the game had run where the recording begins. */
  readonly start: number;
  /** The number of ticks the game had run where it ends. */
  readonly end: number;
  /**
   * The delta of every tick from `start` to `end`, in runs: from each run's
   * `tick` on, every tick took its `delta`, until the next run. The first run
   * begins at `start`.
   */
  readonly deltas: readonly {
    readonly tick: number;
    readonly delta: number;
  }[];
  /** What entered the game from outside, as `app.actionLog` holds it. */
  readonly log: readonly Action.LogEntry[];
}

const Tick = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const RecordingSchema = Schema.fromJsonString(
  Schema.Struct({
    start: Tick,
    end: Tick,
    deltas: Schema.Array(Schema.Struct({ tick: Tick, delta: Schema.Finite })),
    log: Schema.Array(
      Schema.Union([
        Schema.Struct({
          tick: Tick,
          name: Schema.String,
          payload: Schema.Unknown,
          from: Schema.optionalKey(Schema.String),
          queued: Schema.optionalKey(Schema.Literal(true)),
          refused: Schema.optionalKey(Schema.String),
        }),
        Schema.Struct({
          tick: Tick,
          hash: Schema.Int.check(
            Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 })
          ),
        }),
      ])
    ),
  }).check(
    Schema.makeFilter((recording) => {
      if (recording.end < recording.start) {
        return "it ends before it begins";
      }
      const { deltas } = recording;
      if (
        recording.end > recording.start &&
        deltas[0]?.tick !== recording.start
      ) {
        return "its first run of deltas doesn't begin where it does";
      }
      for (let i = 1; i < deltas.length; i++) {
        if (
          deltas[i]!.tick <= deltas[i - 1]!.tick ||
          deltas[i]!.tick >= recording.end
        ) {
          return "its runs of deltas are out of order, or past its end";
        }
      }
      for (let i = 0; i < recording.log.length; i++) {
        const { tick } = recording.log[i]!;
        if (
          tick < recording.start ||
          tick > recording.end ||
          (i > 0 && tick < recording.log[i - 1]!.tick)
        ) {
          return "its log is out of order, or outside it";
        }
      }
      return true;
    })
  )
);

/**
 * Encodes a recording as text, for a file or the network.
 *
 * @category Codecs
 */
export const encode = (recording: Recording): string =>
  JSON.stringify(recording);

/**
 * Decodes a recording from text. It checks the recording's own structure:
 * that its runs of deltas and its log are in order and within it. Each payload
 * is validated against its action's schema, and each checkpoint against the
 * world, when it is replayed.
 *
 * @category Codecs
 */
export const decode = (
  text: string
): Exit.Exit<Recording, Schema.SchemaError> =>
  Schema.decodeExit(RecordingSchema)(text);

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

  constructor(
    world: World,
    time: { readonly tick: number },
    checkpointEvery: number
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
  }

  /** Records the world's hash now, and returns it. */
  checkpoint(): number {
    const hash = this.world.hash();
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
  record(since: Since | undefined): Recording {
    const { began, deltas, entries, time } = this;
    const start = since?.tick ?? began;
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
    return {
      start,
      end: time.tick,
      deltas:
        start === time.tick
          ? []
          : deltas.slice(first).map((run, i) => ({
              tick: i === 0 ? start : run.tick,
              delta: run.delta,
            })),
      // Copies: an enqueued action's entry is told its fate later.
      log: entries.slice(from).map((entry) => ({ ...entry })),
    };
  }
}

/**
 * A world's hash differs from the one recorded at the same point in the game.
 * The worlds have differed since some tick after `agreedAt`.
 *
 * @category Errors
 */
export class HashMismatch extends Data.TaggedError("HashMismatch")<{
  /** The tick both hashes were taken at. */
  readonly tick: number;
  /** The recorded hash. */
  readonly expected: number;
  /** The hash of the world compared against it. */
  readonly actual: number;
  /** The tick of the last matching checkpoint, if any. */
  readonly agreedAt: number | undefined;
}> {
  override get message(): string {
    const since =
      this.agreedAt === undefined
        ? "No earlier checkpoint matched, so the two did not start from the same state: check the seed and what was spawned before the first tick"
        : `The last checkpoint that matched was at tick ${this.agreedAt}`;
    return `the world's hash at tick ${this.tick} is ${this.actual}, and ${this.expected} was recorded. ${since}.`;
  }
}

/**
 * A replayed log didn't behave as it did when it was recorded.
 *
 * @category Errors
 */
export class ReplayDiverged extends Data.TaggedError("ReplayDiverged")<{
  /** The position in the log of the entry that failed to match. */
  readonly index: number;
  readonly entry: Action.LogEntry;
  /**
   * Why: the error an action was refused with, or a `HashMismatch` for a
   * checkpoint.
   */
  readonly reason: unknown;
}> {
  /** The tick of the entry that failed to match. */
  get tick(): number {
    return this.entry.tick;
  }

  override get message(): string {
    const { entry, reason } = this;
    if (reason instanceof HashMismatch) {
      return `The replay diverged from its log (entry ${this.index}): ${reason.message}`;
    }
    const text = describe(reason);
    const what = Action.isCheckpoint(entry)
      ? `a checkpoint at tick ${entry.tick}`
      : `"${entry.name}" at tick ${entry.tick}`;
    if (Action.isCheckpoint(entry)) {
      return `Log entry ${this.index} (${what}) was not reached on replay: ${text}`;
    }
    return text.startsWith("the game refused it") || text.startsWith("its tick")
      ? `Log entry ${this.index} (${what}) did not replay: ${text}`
      : `Log entry ${this.index} (${what}) was refused on replay: ${text}`;
  }
}

/**
 * Plays a recording again, from `app.record()`, in an app made with the same
 * plugins and options as the game: a fresh one for a recording of all of it,
 * or one loaded from the save it was recorded since. Each tick takes the delta
 * it took when it was recorded, to the recording's end. With the same
 * systems, the same seed and the same starting state, the result is the same
 * game.
 *
 * The replay verifies itself against the log, and throws `ReplayDiverged` at
 * the first entry that doesn't match:
 *
 * - A checkpoint whose hash differs from the replay's world. The replay stops
 *   at that tick, before applying anything recorded after it. With a checkpoint
 *   every tick, that is the tick it diverged on.
 * - A dispatched action that is refused. The log only holds dispatched actions
 *   that were accepted, so either the log was altered or the game changed
 *   since.
 * - An enqueued action refused where the game accepted it, or vice versa. It is
 *   enqueued again at the point it arrived, and the replay stops after the tick
 *   that applied it.
 *
 * Actions the game's systems and handlers issued aren't in the log:
 * the replay's own simulation issues them again.
 *
 * **Gotchas**
 *
 * - It throws when the app isn't where the recording begins: it has run another
 *   number of ticks.
 * - It runs neither the frame stage nor the input stage: every tick runs with
 *   `{ input: false }`.
 * - A log without checkpoints, from an app created with `checkpointEvery: 0`,
 *   is verified by its actions alone: a replay that has diverged runs until an
 *   action happens to be refused, or to the end.
 *
 * @category Running
 */
export const replay = (app: App.Any, recording: Recording): void => {
  const { deltas, end, log, start } = recording;
  if (app.time.tick !== start) {
    throw new Error(
      `Journal.replay was given a recording that begins at tick ${start}, and the app has run ${app.time.tick} ticks. Replay a recording of a whole game into a fresh app, and one recorded since a save into an app loaded from that save.`
    );
  }
  let next = 0;
  let agreedAt: number | undefined;
  // Enqueued entries the next tick will apply, each with the entry the
  // replaying app logged for it.
  const waiting: {
    readonly index: number;
    readonly entry: Action.Logged;
    readonly mine: Action.Logged;
  }[] = [];
  const applyDue = (): void => {
    for (
      let entry = log[next];
      entry !== undefined && entry.tick === app.time.tick;
      entry = log[next]
    ) {
      if (Action.isCheckpoint(entry)) {
        const actual = app.world.hash();
        if (actual !== entry.hash) {
          throw new ReplayDiverged({
            index: next,
            entry,
            reason: new HashMismatch({
              tick: entry.tick,
              expected: entry.hash,
              actual,
              agreedAt,
            }),
          });
        }
        agreedAt = entry.tick;
      } else if (entry.queued === true) {
        // Enqueued again at the point it arrived, so that it takes its turn
        // among the actions the replay's own simulation issues.
        app.enqueueByName(entry.name, entry.payload, entry.from);
        waiting.push({
          index: next,
          entry,
          mine: app.actionLog.at(-1) as Action.Logged,
        });
      } else {
        const exit = app.dispatchByName(entry.name, entry.payload, entry.from);
        if (Exit.isFailure(exit)) {
          throw new ReplayDiverged({
            index: next,
            entry,
            reason: Cause.squash(exit.cause),
          });
        }
      }
      next++;
    }
  };
  // The tick that has just run applied every action enqueued before it. Each
  // must have met the fate the log records for it.
  const checkQueued = (): void => {
    for (const { entry, index, mine } of waiting) {
      if (mine.refused !== undefined && entry.refused === undefined) {
        throw new ReplayDiverged({ index, entry, reason: mine.refused });
      }
      if (mine.refused === undefined && entry.refused !== undefined) {
        throw new ReplayDiverged({
          index,
          entry,
          reason: `the game refused it (${entry.refused}) and the replay accepted it`,
        });
      }
    }
    waiting.length = 0;
  };
  let run = 0;
  for (let tick = start; tick < end; tick++) {
    while ((deltas[run + 1]?.tick ?? end) <= tick) {
      run++;
    }
    const delta = deltas[run]?.delta;
    if (delta === undefined || deltas[0]!.tick !== start) {
      throw new Error(
        `Journal.replay was given a recording with no delta for tick ${tick}: a recording's first run of deltas begins where it does. Decode a recording with Journal.decode, which checks it.`
      );
    }
    applyDue();
    // A replay reads no device: what the devices said is in the log.
    app.tick(delta, NO_INPUT);
    checkQueued();
  }
  applyDue();
  const unreached = log[next];
  if (unreached !== undefined) {
    throw new ReplayDiverged({
      index: next,
      entry: unreached,
      reason: `its tick (${unreached.tick}) was never reached; the log is out of order or past the recording's end, tick ${end}`,
    });
  }
};
