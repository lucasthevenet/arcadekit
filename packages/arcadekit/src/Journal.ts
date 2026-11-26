/**
 * A game's journal: the log of what entered it from outside, with
 * checkpoints of its world's hash, the recording made of it, and the replay
 * that plays a recording again.
 *
 *   const recording = yield* app.record()          // the game so far
 *   const bytes = Journal.encode(recording)        // for a file or the network
 *
 *   // The same game, begun the same way, and checked as it is played.
 *   const again = yield* Journal.replay(recording, game)
 *
 * An app keeps its journal as it plays: every action that enters from
 * outside the simulation, a checkpoint of the world's hash at a regular
 * interval of ticks, and how long each tick was. A recording also holds how
 * its game began, its `seed` or the `save` it was recorded since, as
 * `App.make` takes them. A replay makes an app of the game from that start,
 * applies the log to it, and stops at the first action or checkpoint that
 * doesn't match, or at its end on a world with another hash than the
 * recorded game ended on.
 */
import { Brand, Cause, Data, Effect, Exit, Schema, SchemaIssue } from "effect";
import { SchemaBinary } from "effect/encoding";

import * as Action from "./Action.ts";
import * as App from "./App.ts";
import { said } from "./internal/intake.ts";
import { recorded, tickOf } from "./internal/journal.ts";
import { partsOf } from "./internal/parts.ts";
import { Layout } from "./internal/recording.ts";
import type * as Plugin from "./Plugin.ts";
import * as Save from "./Save.ts";

/**
 * How a recorded game began: its `seed`, when it was recorded from its start,
 * or the `save` it was recorded since. A save holds where the game's random
 * sequence had got to, so a recording holds one of the two, never both. It
 * has the form `App.make` takes, and `Journal.replay` makes its app from it.
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
  /** The world's hash at `end`, which a replay ends on. */
  readonly endHash: number;
  /**
   * The delta of every tick from `start` to `end`, in runs. Every tick from a
   * run's `tick` up to the next run took the run's `delta`. The first run
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
 * A game as it was played, which `app.record()` returns and `Journal.replay`
 * plays again: how it began, and what was played of it. With the game, it is
 * everything a replay needs. Only `app.record()` and `Journal.decode` make
 * one, so a recording is one that a game played or that was checked.
 *
 * @category Models
 */
export type Recording = Played & Origin & Brand.Brand<"arcadekit/Recording">;

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
    return `its save can't be read: ${said(Cause.squash(read.cause))}`;
  }
  let tick: number;
  try {
    tick = tickOf(read.value);
  } catch (error) {
    return `its save can't be read: ${said(error)}`;
  }
  return (
    tick === start ||
    `it begins at tick ${start}, and its save was made at tick ${tick}`
  );
};

const RecordingSchema = Layout.check(
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
);

const codec = SchemaBinary.toCodec(RecordingSchema);

/** The first byte of a recording that an earlier arcadekit wrote as JSON. */
const OPEN_BRACE = 0x7b;

/**
 * Encodes a recording in bytes, for a file or the network. A recording made
 * since a save holds the save, as the bytes `Save.encode` writes, which are
 * most of it. The bytes are the recording's own, in a buffer of their own.
 *
 * **Gotchas**
 *
 * It throws when a payload in the log has no JSON form: a bigint, or no
 * payload at all, given to `app.enqueueByName` under a name the game doesn't
 * have.
 *
 * @category Codecs
 */
export const encode = (recording: Recording): Uint8Array<ArrayBuffer> => {
  const { save, ...rest } = recording;
  const bytes = Schema.encodeExit(codec)(
    save === undefined ? rest : { ...rest, save: Save.encode(save) }
  );
  if (Exit.isFailure(bytes)) {
    throw new Error(
      "Journal.encode can't write this recording: a payload in its log has no JSON form. An action enqueued by a name the game doesn't have is logged with the payload it was given.",
      { cause: Cause.squash(bytes.cause) }
    );
  }
  return bytes.value.slice();
};

/**
 * Decodes a recording from bytes, and fails with a `Schema.SchemaError` on
 * bytes that aren't one. It checks the recording's own structure: that it
 * says how its game began, that a save it holds decodes and was made at the
 * tick the recording begins at, and that its log and its runs of deltas are
 * in order and within it. A replay checks the rest: each payload against its
 * action's schema, and each checkpoint and its `endHash` against the world.
 *
 * A recording that an earlier version of arcadekit wrote as text is refused,
 * with a message that begins `older format`.
 *
 * @category Codecs
 */
export const decode = (
  bytes: Uint8Array
): Exit.Exit<Recording, Schema.SchemaError> => {
  const read = Schema.decodeUnknownExit(codec)(bytes);
  if (Exit.isFailure(read)) {
    return bytes[0] === OPEN_BRACE
      ? Exit.fail(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message:
                "older format: it was written as text by an earlier arcadekit, and this version reads a recording in bytes",
            })
          )
        )
      : Exit.failCause(read.cause);
  }
  const { save, seed, ...played } = read.value;
  if (save === undefined) {
    return Exit.succeed(recorded({ ...played, seed: seed ?? 0 }));
  }
  // The schema read the save once already, to check it.
  return Exit.match(Save.decode(save), {
    onSuccess: (loaded) => Exit.succeed(recorded({ ...played, save: loaded })),
    onFailure: (cause) => Exit.die(Cause.squash(cause)),
  });
};

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
  /**
   * The position in the log of the entry that failed to match, or the log's
   * length when the replay ended on another world than the recording did.
   */
  readonly index: number;
  /**
   * The entry that failed to match. Where the replay ended on another world,
   * a checkpoint of the recording's `end` and `endHash`.
   */
  readonly entry: Action.LogEntry;
  /**
   * Why it failed to match: a `HashMismatch` for a checkpoint, the error a
   * dispatched action was refused with, or text that says how an enqueued
   * action went otherwise.
   */
  readonly reason: unknown;
  /**
   * The replay's app, where the replay stopped. The replay has closed it.
   * Its world, its log and its time are there to read.
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
    const text = said(reason);
    const what = Action.isCheckpoint(entry)
      ? `a checkpoint at tick ${entry.tick}`
      : `"${entry.name}" at tick ${entry.tick}`;
    return text.startsWith("the game refused it")
      ? `Log entry ${this.index} (${what}) did not replay: ${text}`
      : `Log entry ${this.index} (${what}) was refused on replay: ${text}`;
  }
}

/**
 * Applies a recording to the app made from how it began, tick by tick, and
 * returns `ReplayDiverged` at the first entry that doesn't match. It fails
 * with what a tick fails with.
 */
const play = Effect.fnUntraced(function* <E, HU>(
  app: App.App<E, HU>,
  recording: Recording
) {
  type A = App.App<E, HU>;
  const { deltas, end, endHash, log, start } = recording;
  const diverged = (index: number, entry: Action.LogEntry, reason: unknown) =>
    new ReplayDiverged({ index, entry, reason, app });
  let next = 0;
  let agreedAt: number | undefined;
  const checkHash = (
    index: number,
    entry: Action.Checkpoint
  ): ReplayDiverged<A> | undefined => {
    const actual = partsOf(app).world._fullHash();
    if (actual !== entry.hash) {
      return diverged(
        index,
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
    return undefined;
  };
  // Enqueued entries the next tick will apply, each with the entry the
  // replaying app logged for it.
  const waiting: {
    readonly index: number;
    readonly entry: Action.Logged;
    readonly mine: Action.Logged;
  }[] = [];
  const applyDue = Effect.fnUntraced(function* () {
    for (
      let entry = log[next];
      entry !== undefined && entry.tick === app.time.tick;
      entry = log[next]
    ) {
      if (Action.isCheckpoint(entry)) {
        const mismatch = checkHash(next, entry);
        if (mismatch !== undefined) {
          return mismatch;
        }
      } else if (entry.queued === true) {
        // Enqueued again at the point it arrived, so that it takes its turn
        // among the actions the replay's own simulation issues.
        yield* app.enqueueByName(entry.name, entry.payload, entry.from);
        waiting.push({
          index: next,
          entry,
          mine: app.actionLog.at(-1) as Action.Logged,
        });
      } else {
        const exit = yield* Effect.exit(
          app.dispatchByName(entry.name, entry.payload, entry.from)
        );
        if (Exit.isFailure(exit)) {
          return diverged(next, entry, Cause.squash(exit.cause));
        }
      }
      next++;
    }
    return undefined;
  });
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
    const { delta } = deltas[run]!;
    const due = yield* applyDue();
    if (due !== undefined) {
      return due;
    }
    yield* app.tick(delta);
    const queued = checkQueued();
    if (queued !== undefined) {
      return queued;
    }
  }
  return (
    (yield* applyDue()) ?? checkHash(log.length, { tick: end, hash: endHash })
  );
});

/**
 * The options of `App.make` that `Journal.replay` gives its app: all of them
 * except `seed` and `save`, since the recording holds how its game began.
 *
 * @category Options
 */
export interface ReplayOptions extends Omit<App.StartOptions, "seed" | "save"> {
  /** Not an option of a replay. The recording holds its seed or its save. */
  readonly seed?: never;
  /** Not an option of a replay. The recording holds its seed or its save. */
  readonly save?: never;
}

/**
 * Plays a recording from `app.record()` again, and returns the app it played
 * it in, where the recording ends. It makes that app of `game` from how the
 * recorded game began: its seed, or the save it was recorded since.
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
 * The app it returns belongs to the caller, as one `App.make` returns does.
 * Close it with `app.close` when you are done with it.
 *
 * The replay checks itself against the log. It fails with `ReplayDiverged`
 * at the first entry that doesn't match, and the error holds the app where
 * the replay stopped. The replay has closed that app already, and it is
 * there to read. An entry doesn't match when it is one of these:
 *
 * - A checkpoint whose hash differs from the replay's world. The replay stops
 *   at that tick, before applying anything recorded after it. With a checkpoint
 *   every tick, that is the tick it diverged on.
 * - The recording's `endHash`, once the replay has reached the recording's
 *   end, when the replay's world has another hash. So a replay that succeeds
 *   ended on the world the recorded game ended on, however few checkpoints
 *   the recording holds.
 * - A dispatched action that is refused. The log holds only dispatched
 *   actions that were accepted, so either the log was altered or the game
 *   changed since.
 * - An enqueued action refused where the game accepted it, or accepted where
 *   the game refused it. It is enqueued again at the point it arrived, and the
 *   replay stops after the tick that applied it.
 *
 * Actions the game's systems and handlers issued aren't in the log. The
 * replay's own simulation issues them again.
 *
 * It also fails as `App.make` does: with the error of a plugin's layer or
 * setup, or with `Save.LoadRefused` when a recording made since a save holds
 * a save this game can't load. And it fails with what a tick fails with,
 * which the game's systems say.
 *
 * **Gotchas**
 *
 * - It runs neither the frame stage nor the input stage. What the devices
 *   reported is already in the log.
 * - A recording from an app made with `checkpointEvery: 0` has no
 *   checkpoints but its `endHash`. A replay that has diverged runs until an
 *   action happens to be refused, or to the end, and fails there.
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
  | ReplayDiverged<App.App<App.TickError<S, P>, App.AllHandlers<H, P>>>
  | App.TickError<S, P>,
  App.External<S, H, P>
> => {
  const origin: Origin =
    recording.save === undefined
      ? { seed: recording.seed }
      : { save: recording.save };
  return Effect.flatMap(App.make(game, { ...options, ...origin }), (made) =>
    Effect.onError(
      Effect.flatMap(play(made, recording), (diverged) =>
        diverged === undefined ? Effect.succeed(made) : Effect.fail(diverged)
      ),
      () => made.close
    )
  );
};
