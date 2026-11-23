/**
 * A game's journal: the log of what entered it from outside, with
 * checkpoints of its world's hash, the recording made of it, and the replay
 * that plays a recording again.
 *
 *   const recording = app.record()                 // the game so far
 *   const text = Journal.encode(recording)         // for a file or the network
 *
 *   // The same game, begun the same way, and checked as it is played.
 *   const again = yield* Journal.replay(recording, game)
 *
 * An app keeps its journal as it plays: every action from outside the
 * simulation, a checkpoint of the world's hash at a regular interval of
 * ticks, and how long each tick was. A recording holds how its game began
 * beside them, its seed or its save, in the words `App.make` takes. A replay
 * makes an app of the game from that, applies the log to the app, and stops
 * at the first action or checkpoint that doesn't match.
 */
import { Cause, Data, Effect, Exit, Schema } from "effect";
import { Base64 } from "effect/encoding";

import * as Action from "./Action";
import * as App from "./App";
import { partsOf } from "./app/parts";
import type { Store } from "./ecs/store";
import type { World } from "./ecs/world";
import type * as Plugin from "./Plugin";
import * as Save from "./Save";
import { GameTime } from "./Stage";

/**
 * How a recorded game began: the seed of one recorded from its start, or the
 * save of one recorded since. A save holds where its game's random sequence
 * had got to, so a recording has one of the two, in the words `App.make`
 * takes. `Journal.replay` makes its app from it.
 *
 * @category Models
 */
export type Origin =
  | { readonly seed: number; readonly save?: undefined }
  | { readonly save: Save.Save; readonly seed?: never };

/**
 * What a recording holds of a game beside how it began.
 *
 * @category Models
 */
export interface Played {
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

/**
 * A game as it was played, from `app.record()`, for `Journal.replay` to play
 * again: how it began, and what was played of it. With the game, it is
 * everything a replay needs.
 *
 * @category Models
 */
export type Recording = Played & Origin;

/** The tick a save was made at, which its world holds. */
const tickOf = (save: Save.Save): number => {
  const tick = Save.singleton(save, GameTime.component.name, "tick");
  return typeof tick === "number" ? tick : 0;
};

/** What is wrong with how a recording says its game began, or true. */
const originHolds = (recording: {
  readonly start: number;
  readonly seed?: number;
  readonly save?: Uint8Array;
}): true | string => {
  const { save, seed, start } = recording;
  if ((seed === undefined) === (save === undefined)) {
    return "it holds how its game began as a seed or as a save, one of the two";
  }
  if (save === undefined) {
    return (
      start === 0 ||
      `it begins at tick ${start} with a seed, and a game begins at tick 0`
    );
  }
  const read = Save.decode(save);
  if (Exit.isFailure(read)) {
    return `its save can't be read: ${Action.said(Cause.squash(read.cause))}`;
  }
  let tick: number;
  try {
    tick = tickOf(read.value);
  } catch (error) {
    return `its save can't be read: ${Action.said(error)}`;
  }
  return (
    tick === start ||
    `it begins at tick ${start}, and its save was made at tick ${tick}`
  );
};

const Tick = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const RecordingSchema = Schema.fromJsonString(
  Schema.Struct({
    seed: Schema.optionalKey(Tick),
    save: Schema.optionalKey(Schema.Uint8ArrayFromBase64),
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
      const origin = originHolds(recording);
      if (origin !== true) {
        return origin;
      }
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
 * Encodes a recording as text, for a file or the network. One recorded since
 * a save holds the save, which is most of its length.
 *
 * @category Codecs
 */
export const encode = (recording: Recording): string =>
  JSON.stringify(
    recording.save === undefined
      ? recording
      : { ...recording, save: Base64.encode(Save.encode(recording.save)) }
  );

/**
 * Decodes a recording from text. It checks the recording's own structure:
 * that it says how its game began, that a save it holds reads and is of the
 * tick it begins at, and that its runs of deltas and its log are in order
 * and within it. Each payload is validated against its action's schema, and
 * each checkpoint against the world, when it is replayed.
 *
 * @category Codecs
 */
export const decode = (
  text: string
): Exit.Exit<Recording, Schema.SchemaError> => {
  const read = Schema.decodeExit(RecordingSchema)(text);
  if (Exit.isFailure(read)) {
    return Exit.failCause(read.cause);
  }
  const { save, seed, ...played } = read.value;
  if (save === undefined) {
    return Exit.succeed({ ...played, seed: seed ?? 0 });
  }
  // The schema read the save once already, to check it.
  return Exit.match(Save.decode(save), {
    onSuccess: (loaded) => Exit.succeed({ ...played, save: loaded }),
    onFailure: (cause) => Exit.die(Cause.squash(cause)),
  });
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
    return {
      ...(since === undefined ? this.origin : { save: since }),
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
        ? "No earlier checkpoint matched, so the two did not start from the same state: check the seed, and what the plugins' setups spawn"
        : `The last checkpoint that matched was at tick ${this.agreedAt}`;
    return `the world's hash at tick ${this.tick} is ${this.actual}, and ${this.expected} was recorded. ${since}.`;
  }
}

/**
 * A replayed log didn't behave as it did when it was recorded. It holds the
 * replay's app, stopped where it diverged, to look at.
 *
 *   Journal.replay(recording, Duel).pipe(
 *     Effect.catchTag("ReplayDiverged", (diverged) =>
 *       diverged.app.read(World)  // the world where the replay stopped
 *     )
 *   )
 *
 * @typeParam A The app the replay made.
 * @category Errors
 */
export class ReplayDiverged<
  A extends App.Any = App.Any,
> extends Data.TaggedError("ReplayDiverged")<{
  /** The position in the log of the entry that failed to match. */
  readonly index: number;
  readonly entry: Action.LogEntry;
  /**
   * Why: the error an action was refused with, or a `HashMismatch` for a
   * checkpoint.
   */
  readonly reason: unknown;
  /**
   * The replay's app, where the replay stopped. The replay has closed it: its
   * world, its log and its time are there to read.
   */
  readonly app: A;
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
    const text = Action.said(reason);
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
 * Applies a recording to the app made from how it began, tick by tick, and
 * returns `ReplayDiverged` at the first entry that doesn't match.
 */
const play = <A extends App.Any>(
  app: A,
  recording: Recording
): ReplayDiverged<A> | undefined => {
  const { deltas, end, log, start } = recording;
  if (app.time.tick !== start) {
    const began =
      recording.save === undefined
        ? "with a seed, and a game begins at tick 0"
        : `and its save was made at tick ${app.time.tick}`;
    throw new Error(
      `Journal.replay was given a recording that begins at tick ${start}, ${began}. Decode a recording with Journal.decode, which checks it.`
    );
  }
  const diverged = (index: number, entry: Action.LogEntry, reason: unknown) =>
    new ReplayDiverged({ index, entry, reason, app });
  let next = 0;
  let agreedAt: number | undefined;
  // Enqueued entries the next tick will apply, each with the entry the
  // replaying app logged for it.
  const waiting: {
    readonly index: number;
    readonly entry: Action.Logged;
    readonly mine: Action.Logged;
  }[] = [];
  const applyDue = (): ReplayDiverged<A> | undefined => {
    for (
      let entry = log[next];
      entry !== undefined && entry.tick === app.time.tick;
      entry = log[next]
    ) {
      if (Action.isCheckpoint(entry)) {
        const actual = partsOf(app).world.hash();
        if (actual !== entry.hash) {
          return diverged(
            next,
            entry,
            new HashMismatch({
              tick: entry.tick,
              expected: entry.hash,
              actual,
              agreedAt,
            })
          );
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
          return diverged(next, entry, Cause.squash(exit.cause));
        }
      }
      next++;
    }
    return undefined;
  };
  // The tick that has just run applied every action enqueued before it. Each
  // must have met the fate the log records for it.
  const checkQueued = (): ReplayDiverged<A> | undefined => {
    for (const { entry, index, mine } of waiting) {
      if (mine.refused !== undefined && entry.refused === undefined) {
        return diverged(index, entry, mine.refused);
      }
      if (mine.refused === undefined && entry.refused !== undefined) {
        return diverged(
          index,
          entry,
          `the game refused it (${entry.refused}) and the replay accepted it`
        );
      }
    }
    waiting.length = 0;
    return undefined;
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
    const due = applyDue();
    if (due !== undefined) {
      return due;
    }
    app.tick(delta);
    const queued = checkQueued();
    if (queued !== undefined) {
      return queued;
    }
  }
  const due = applyDue();
  if (due !== undefined) {
    return due;
  }
  const unreached = log[next];
  return unreached === undefined
    ? undefined
    : diverged(
        next,
        unreached,
        `its tick (${unreached.tick}) was never reached; the log is out of order or past the recording's end, tick ${end}`
      );
};

/**
 * What `Journal.replay` makes its app with beside the recording: the options
 * of `App.make`, without where the game starts, which the recording says.
 *
 * @category Options
 */
export interface ReplayOptions extends Omit<App.StartOptions, "seed" | "save"> {
  /** Not an option of a replay: the recording holds its seed or its save. */
  readonly seed?: never;
  /** Not an option of a replay: the recording holds its seed or its save. */
  readonly save?: never;
}

/**
 * Plays a recording again, from `app.record()`, in an app of `game` made from
 * how the recorded game began, its seed or the save it was recorded since,
 * and returns that app where the recording ends:
 *
 *   const again = yield* Journal.replay(recording, Duel)
 *   const checked = yield* Journal.replay(recording, Duel, {
 *     checkpointEvery: 1,
 *   })
 *
 * Each tick takes the delta it took when it was recorded, to the recording's
 * end. With the same systems and the same beginning, the result is the same
 * game.
 *
 * The app it returns is the caller's, as one `App.make` returns is: close it
 * with `app.close` when done with it.
 *
 * The replay verifies itself against the log, and fails with
 * `ReplayDiverged` at the first entry that doesn't match, which holds the
 * app where the replay stopped, closed already, to read:
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
 * It fails as `App.make` does too: with `Save.LoadRefused` when a recording
 * made since a save holds one this game can't load.
 *
 * **Gotchas**
 *
 * - It runs neither the frame stage nor the input stage: what the devices
 *   said is in the log.
 * - A log without checkpoints, from an app created with `checkpointEvery: 0`,
 *   is verified by its actions alone: a replay that has diverged runs until an
 *   action happens to be refused, or to the end.
 *
 * @category Running
 */
export const replay = <
  S extends App.Systems = readonly [],
  H extends App.Handlers = readonly [],
  P extends App.Plugins = readonly [],
>(
  recording: Recording,
  game: App.Game<S, H, P>,
  options?: ReplayOptions
): Effect.Effect<
  App.App<App.TickError<S, P>, App.AllHandlers<H, P>>,
  | Plugin.ErrorOf<P[number]>
  | Save.LoadRefused
  | ReplayDiverged<App.App<App.TickError<S, P>, App.AllHandlers<H, P>>>,
  App.External<S, H, P>
> => {
  const origin: Origin =
    recording.save === undefined
      ? { seed: recording.seed }
      : { save: recording.save };
  return Effect.flatMap(App.make(game, { ...options, ...origin }), (made) =>
    Effect.onError(
      Effect.suspend(() => {
        const diverged = play(made, recording);
        return diverged === undefined
          ? Effect.succeed(made)
          : Effect.fail(diverged);
      }),
      () => made.close
    )
  );
};
