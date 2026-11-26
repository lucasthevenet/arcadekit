/**
 * A replay plays a game again from its recording: how the game began, and
 * the log of what entered it from outside, with hash checks of its world.
 *
 *   const recording = yield* Replay.record(app)     // the game so far
 *   const bytes = yield* Replay.encode(recording)   // for a file or the network
 *
 *   // The same game, begun the same way, and checked as it is played.
 *   const again = yield* Replay.verify(recording, game)
 *   // Or watched, at its own pace, in a page.
 *   Driver.run(Replay.play(recording, game))
 *
 * An app keeps its log as it plays: every action that enters from outside
 * the simulation, a hash check of the world's hash at a regular interval of
 * ticks, and how long each tick was. A recording also holds how its game
 * began, its `seed` or the `save` it was recorded since, as `App.make` takes
 * them. A replay makes an app of the game from that start, applies the log
 * to it, and stops at the first action or hash check that doesn't match, or
 * at its end on a world with another hash than the recorded game ended on.
 */
import { Brand, Cause, Data, Effect, Exit, Schema } from "effect";
import { SchemaBinary } from "effect/encoding";

import * as Action from "./Action.ts";
import * as App from "./App.ts";
import type * as Driver from "./Driver.ts";
import { said } from "./internal/intake.ts";
import { recorded, tickOf } from "./internal/log.ts";
import { partsOf } from "./internal/parts.ts";
import { Layout } from "./internal/recording.ts";
import type * as Plugin from "./Plugin.ts";
import * as Save from "./Save.ts";
import * as Timeline from "./Timeline.ts";

/**
 * How a recorded game began: its `seed`, when it was recorded from its start,
 * or the `save` it was recorded since. A save holds where the game's random
 * sequence had got to, so a recording holds one of the two, never both. It
 * has the form `App.make` takes, and `Replay.verify` makes its app from it.
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
 * A game as it was played, which `Replay.record` returns, `Replay.verify`
 * plays again and `Replay.play` lets a person watch: how it began, and what
 * was played of it. With the game, it is everything a replay needs. Only
 * `Replay.record` and `Replay.decode` make one, so a recording is one that a
 * game played or that was checked.
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
 * A recording that can't be written as bytes, or bytes that aren't a
 * recording. `problem` names the kind of failure:
 *
 * - `"no JSON form"`: a payload in the recording's log has no JSON form, as a
 *   bigint, or no payload at all, given to `app.enqueueByName` under a name
 *   the game doesn't have;
 * - `"not a recording"`: the bytes aren't a recording, or one whose structure
 *   doesn't hold;
 * - `"older format"`: an earlier version of arcadekit wrote it as text, and
 *   this version reads a recording in bytes.
 *
 * @category Errors
 */
export class Invalid extends Data.TaggedError("ReplayInvalid")<{
  readonly problem: "no JSON form" | "not a recording" | "older format";
  readonly message: string;
}> {}

/**
 * Encodes a recording in bytes, for a file or the network. A recording made
 * since a save holds the save, as the bytes `Save.encode` writes, which are
 * most of it. The bytes are the recording's own, in a buffer of their own.
 *
 * Fails with `Replay.Invalid`, `"no JSON form"`, when a payload in the log
 * has no JSON form.
 *
 * @category Codecs
 */
export const encode = (
  recording: Recording
): Exit.Exit<Uint8Array<ArrayBuffer>, Invalid> => {
  const { save, ...rest } = recording;
  const bytes = Schema.encodeExit(codec)(
    save === undefined ? rest : { ...rest, save: Save.encode(save) }
  );
  return Exit.isFailure(bytes)
    ? Exit.fail(
        new Invalid({
          problem: "no JSON form",
          message: `Replay.encode can't write this recording: a payload in its log has no JSON form. An action enqueued by a name the game doesn't have is logged with the payload it was given. ${said(Cause.squash(bytes.cause))}`,
        })
      )
    : Exit.succeed(bytes.value.slice());
};

/**
 * Decodes a recording from bytes. It checks the recording's own structure:
 * that it says how its game began, that a save it holds decodes and was made
 * at the tick the recording begins at, and that its log and its runs of
 * deltas are in order and within it. A replay checks the rest: each payload
 * against its action's schema, and each hash check and its `endHash` against
 * the world.
 *
 * Fails with `Replay.Invalid`: `"not a recording"` for bytes that aren't
 * one, and `"older format"` for a recording that an earlier version of
 * arcadekit wrote as text.
 *
 * @category Codecs
 */
export const decode = (bytes: Uint8Array): Exit.Exit<Recording, Invalid> => {
  const read = Schema.decodeUnknownExit(codec)(bytes);
  if (Exit.isFailure(read)) {
    return Exit.fail(
      bytes[0] === OPEN_BRACE
        ? new Invalid({
            problem: "older format",
            message:
              "It was written as text by an earlier arcadekit, and this version reads a recording in bytes.",
          })
        : new Invalid({
            problem: "not a recording",
            message: said(Cause.squash(read.cause)),
          })
    );
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
export class HashMismatch extends Data.TaggedError("ReplayHashMismatch")<{
  /** The tick both hashes were taken at. */
  readonly tick: number;
  /** The recorded hash. */
  readonly expected: number;
  /** The hash of the world compared against it. */
  readonly actual: number;
  /** The tick of the last matching hash check, if any. */
  readonly agreedAt: number | undefined;
}> {
  override get message(): string {
    const since =
      this.agreedAt === undefined
        ? "No earlier hash check matched, so the two did not start from the same state: check the seed, and what the plugins' setups spawn"
        : `The last hash check that matched was at tick ${this.agreedAt}`;
    return `the world's hash at tick ${this.tick} is ${this.actual}, and ${this.expected} was recorded. ${since}.`;
  }
}

/**
 * A replayed log didn't behave as it did when it was recorded. It holds the
 * replay's app, stopped where it diverged, to look at.
 *
 *   Replay.verify(recording, Duel).pipe(
 *     Effect.catchTag("ReplayDiverged", (diverged) =>
 *       diverged.app.read(World)  // the world where the replay stopped
 *     )
 *   )
 *
 * @typeParam A The app the replay made.
 * @category Errors
 */
export class Diverged<A extends App.Any = App.Any> extends Data.TaggedError(
  "ReplayDiverged"
)<{
  /**
   * The position in the log of the entry that failed to match, or the log's
   * length when the replay ended on another world than the recording did.
   */
  readonly index: number;
  /**
   * The entry that failed to match. Where the replay ended on another world,
   * a hash check of the recording's `end` and `endHash`.
   */
  readonly entry: Action.LogEntry;
  /**
   * Why it failed to match: a `HashMismatch` for a hash check, the error a
   * dispatched action was refused with, or text that says how an enqueued
   * action went otherwise.
   */
  readonly reason: unknown;
  /**
   * The replay's app, where the replay stopped. `Replay.verify` has closed
   * it, and a player closes it when it is closed. Its world, its log and its
   * time are there to read.
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
    const what = Action.isHashCheck(entry)
      ? `a hash check at tick ${entry.tick}`
      : `"${entry.name}" at tick ${entry.tick}`;
    return text.startsWith("the game refused it")
      ? `Log entry ${this.index} (${what}) did not replay: ${text}`
      : `Log entry ${this.index} (${what}) was refused on replay: ${text}`;
  }
}

/** Where a stepper is in its recording, between two ticks. */
interface Mark {
  readonly next: number;
  readonly run: number;
  readonly agreedAt: number | undefined;
}

/**
 * A recording played in the app made from how it began, a tick at a time,
 * and checked against its log as it goes: what `verify` runs to the end, and
 * what a player steps at its own pace.
 */
interface Stepper<A extends App.Any, E> {
  /** Whether every tick of the recording has run. */
  readonly done: boolean;
  /**
   * Runs the recording's next tick, with the delta it was recorded with, and
   * succeeds with where it diverged, if it did. Once the last tick has run, it
   * checks the world against where the recording ends.
   */
  readonly step: () => Effect.Effect<Diverged<A> | undefined, E>;
  /** Checks the world against where the recording ends, once it has. */
  readonly finish: () => Effect.Effect<Diverged<A> | undefined, E>;
  /** Where it is in the recording. */
  readonly mark: () => Mark;
  /** Goes back to where it was, with the app put back to that tick. */
  readonly restore: (mark: Mark) => void;
}

/** Makes the stepper of a recording, in the app made from how it began. */
const stepperOf = <E, HU>(
  app: App.App<E, HU>,
  recording: Recording
): Stepper<App.App<E, HU>, E> => {
  type A = App.App<E, HU>;
  const { deltas, end, endHash, log } = recording;
  const diverged = (index: number, entry: Action.LogEntry, reason: unknown) =>
    new Diverged({ index, entry, reason, app });
  let next = 0;
  let run = 0;
  let agreedAt: number | undefined;
  const checkHash = (
    index: number,
    entry: Action.HashCheck
  ): Diverged<A> | undefined => {
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
      if (Action.isHashCheck(entry)) {
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
  const checkQueued = (): Diverged<A> | undefined => {
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
  const finish = Effect.fnUntraced(function* () {
    return (
      (yield* applyDue()) ?? checkHash(log.length, { tick: end, hash: endHash })
    );
  });
  const step = Effect.fnUntraced(function* () {
    const tick = app.time.tick;
    while ((deltas[run + 1]?.tick ?? end) <= tick) {
      run++;
    }
    const due = yield* applyDue();
    if (due !== undefined) {
      return due;
    }
    yield* app.tick(deltas[run]!.delta);
    const queued = checkQueued();
    if (queued !== undefined || app.time.tick < end) {
      return queued;
    }
    return yield* finish();
  });
  return {
    get done() {
      return app.time.tick >= end;
    },
    step,
    finish,
    mark: () => ({ next, run, agreedAt }),
    restore: (mark) => {
      ({ agreedAt, next, run } = mark);
      waiting.length = 0;
    },
  };
};

/**
 * The options of `App.make` that `Replay.verify` and `Replay.play` give
 * their app: all of them except `seed` and `save`, since the recording holds
 * how its game began.
 *
 * @category Options
 */
export interface Options extends Omit<App.StartOptions, "seed" | "save"> {
  /** Not an option of a replay. The recording holds its seed or its save. */
  readonly seed?: never;
  /** Not an option of a replay. The recording holds its seed or its save. */
  readonly save?: never;
}

/** Makes the app of a recording's game, from how the recorded game began. */
const appOf = <
  S extends App.Systems,
  H extends App.Handlers,
  P extends App.Plugins,
>(
  recording: Recording,
  game: App.Game<S, H, P>,
  options: Options | undefined
) =>
  App.make(game, {
    ...options,
    ...(recording.save === undefined
      ? { seed: recording.seed }
      : { save: recording.save }),
  } as App.StartOptions<Save.Save | undefined>) as Effect.Effect<
    App.App<App.TickError<S, P>, App.AllHandlers<H, P>>,
    Plugin.ErrorOf<P[number]> | Save.LoadRefused,
    App.External<S, H, P>
  >;

/**
 * Plays a recording from `Replay.record` again, all of it at once, and
 * returns the app it played it in, where the recording ends. It makes that
 * app of `game` from how the recorded game began: its seed, or the save it
 * was recorded since.
 *
 *   const again = yield* Replay.verify(recording, Duel)
 *   const checked = yield* Replay.verify(recording, Duel, {
 *     hashEvery: 1,
 *   })
 *
 * Each tick takes the delta it took when it was recorded, to the recording's
 * end. With the same systems and the same beginning, the result is the same
 * game.
 *
 * **When to use**
 *
 * Use to check that a game replays, as a test or a server does. To watch a
 * recording at its own pace, drawn, use `Replay.play`.
 *
 * **Details**
 *
 * The app it returns belongs to the caller, as one `App.make` returns does.
 * Close it with `app.close` when you are done with it.
 *
 * The replay checks itself against the log. It fails with `Replay.Diverged`
 * at the first entry that doesn't match, and the error holds the app where
 * the replay stopped. The replay has closed that app already, and it is
 * there to read. An entry doesn't match when it is one of these:
 *
 * - A hash check whose hash differs from the replay's world. The replay
 *   stops at that tick, before applying anything recorded after it. With a
 *   hash check every tick, that is the tick it diverged on.
 * - The recording's `endHash`, once the replay has reached the recording's
 *   end, when the replay's world has another hash. So a replay that succeeds
 *   ended on the world the recorded game ended on, however few hash checks
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
 * - A recording from an app made with `hashEvery: 0` has no hash checks but
 *   its `endHash`. A replay that has diverged runs until an action happens to
 *   be refused, or to the end, and fails there.
 *
 * @category Running
 */
export const verify = <
  S extends App.Systems = readonly [],
  H extends App.Handlers = readonly [],
  P extends App.Plugins = readonly [],
>(
  recording: Recording,
  game: App.Game<S, H, P>,
  options?: Options
): Effect.Effect<
  App.App<App.TickError<S, P>, App.AllHandlers<H, P>>,
  | Plugin.ErrorOf<P[number]>
  | Save.LoadRefused
  | Diverged<App.App<App.TickError<S, P>, App.AllHandlers<H, P>>>
  | App.TickError<S, P>,
  App.External<S, H, P>
> =>
  Effect.flatMap(appOf(recording, game, options), (made) =>
    Effect.onError(
      Effect.gen(function* () {
        const stepper = stepperOf(made, recording);
        let diverged = stepper.done ? yield* stepper.finish() : undefined;
        while (diverged === undefined && !stepper.done) {
          diverged = yield* stepper.step();
        }
        return diverged === undefined ? made : yield* diverged;
      }),
      () => made.close
    )
  );

/**
 * Returns the game as it was played, to play again with `Replay.verify` or
 * watch with `Replay.play`: how it began, the action log, the delta of every
 * tick, the ticks it begins and ends at, and the world's hash where it ends.
 * The recording begins where the app began, from its seed or from the save it
 * was made or last loaded from. With `since`, a save the app made, it begins
 * at that save and holds it, and replaying it returns to the present from
 * that save. Run it only between ticks, since it dies anywhere else.
 *
 *   const recording = yield* Replay.record(app)
 *   const tail = yield* Replay.record(app, save)
 *
 * **Gotchas**
 *
 * - It dies for a save the app didn't make, or one its log no longer reaches,
 *   since the game went back to before it.
 * - An app made from a save keeps that save for as long as it lives, to
 *   record from.
 *
 * @category Constructors
 */
export const record = (
  app: Pick<App.Any, "phase">,
  since?: Save.Save
): Effect.Effect<Recording> => Effect.suspend(() => partsOf(app).record(since));

/**
 * Records the world's hash in the app's log now, as a hash check, and
 * returns it. Use it for points the game wants verified beyond the ones
 * `hashEvery` records, such as when it is saved. Run it only between ticks,
 * since it dies anywhere else.
 *
 * @category Running
 */
export const hashCheck = (app: Pick<App.Any, "phase">): Effect.Effect<number> =>
  Effect.suspend(() => partsOf(app).hashCheck());

// --- a recording a person watches -----------------------------------------------------

/**
 * How many ticks apart a player keeps the game, to go back to when it seeks
 * back: a second of a game at 60 Hz.
 */
const KEYFRAME = 60;

/**
 * A recording played for a person to watch, as `Replay.play` makes it: its
 * app, stepped a recorded tick at a time by a driver, at the recording's own
 * pace, with its frame stage drawing it. It pauses, goes faster or slower,
 * and goes to any tick.
 *
 * It is what a driver runs, as a session is: `Driver.run(Replay.play(...))`
 * runs it until interrupted, and closes it.
 *
 * @typeParam A the app it plays in
 * @typeParam E what a tick of the app fails with
 *
 * @category Models
 */
export interface Player<A extends App.Any, E>
  extends Driver.Paced<E | Diverged<A>>, Driver.Closes {
  /** The app it plays in, to read and to draw. Its tick is where it is. */
  readonly app: A;
  /** The recording it plays. */
  readonly recording: Recording;
  /** Whether it is paused: a tick of the driver runs none of the recording's. */
  readonly paused: boolean;
  /** How many of the recording's ticks it runs for each of the driver's. */
  readonly rate: number;
  /** Whether it has played the recording to its end, and ended on its hash. */
  readonly ended: boolean;
  /**
   * Plays on, at `rate` of the recording's ticks for each of the driver's, 1
   * unless given: 2 is twice as fast, 0.5 half as fast.
   */
  readonly play: (rate?: number) => Effect.Effect<void>;
  /** Pauses: the driver goes on drawing the game where it is. */
  readonly pause: Effect.Effect<void>;
  /**
   * Goes to a tick of the recording, forward or back, and stays paused or
   * playing as it was. The frame stage draws the game there, and hears
   * nothing of the ticks it went past. It fails as a tick does, and with
   * `Replay.Diverged` where the recording doesn't replay.
   */
  readonly seek: (tick: number) => Effect.Effect<void, E | Diverged<A>>;
}

/**
 * Makes a player of a recording, for a person to watch: the app of `game`
 * made from how the recorded game began, which a driver steps at the
 * recording's own pace and draws, and which pauses, changes speed and goes
 * to any tick. It checks the recording against its log as it plays, as
 * `Replay.verify` does, and ends on the recording's hash.
 *
 *   Browser.runMain(
 *     Driver.run(Replay.play(recording, Duel), {
 *       ready: (player) => Effect.sync(() => { ... })   // buttons: pause, play, seek
 *     }),
 *     { target: canvas }
 *   )
 *
 * **When to use**
 *
 * Use for a replay a player watches, a kill-cam, a spectator's view, or a
 * tool that scrubs through a bug. To check a recording all at once, use
 * `Replay.verify`.
 *
 * **Details**
 *
 * - The driver runs it at `1 / delta` ticks a second, the delta of the
 *   recording's first tick, and each of its ticks runs one of the
 *   recording's, with the delta that tick was recorded with.
 * - It runs neither the input stage, since the log holds what the devices
 *   said, nor more than the recording holds: at the end, it stands still.
 * - It keeps the game every 60 ticks, as `Timeline.capture` does, to seek
 *   back from: a seek back goes to the nearest one before, and plays on from
 *   there.
 * - A tick that doesn't replay as it was recorded fails with
 *   `Replay.Diverged`, which stops the driver.
 * - The player owns its app, and closes it with `close`, as `Driver.run`
 *   does when it ends.
 *
 * @category Running
 */
export const play = <
  S extends App.Systems = readonly [],
  H extends App.Handlers = readonly [],
  P extends App.Plugins = readonly [],
>(
  recording: Recording,
  game: App.Game<S, H, P>,
  options?: Options
): Effect.Effect<
  Player<
    App.App<App.TickError<S, P>, App.AllHandlers<H, P>>,
    App.TickError<S, P>
  >,
  Plugin.ErrorOf<P[number]> | Save.LoadRefused,
  App.External<S, H, P>
> =>
  Effect.flatMap(appOf(recording, game, options), (app) =>
    Effect.suspend(() => {
      type A = typeof app;
      type E = App.TickError<S, P>;
      const stepper = stepperOf(app, recording);
      const { start, end } = recording;
      const kept: {
        readonly tick: number;
        readonly moment: Timeline.Moment;
        readonly mark: Mark;
      }[] = [];
      let paused = false;
      let rate = 1;
      let owed = 0;
      let ended = false;
      /** Keeps the game where it is, at every keyframe it reaches the first time. */
      const keep = Effect.fnUntraced(function* () {
        const tick = app.time.tick;
        if (
          (tick - start) % KEYFRAME !== 0 ||
          (kept.at(-1)?.tick ?? -1) >= tick
        ) {
          return;
        }
        const moment = yield* Effect.orDie(Timeline.capture(app));
        kept.push({ tick, moment, mark: stepper.mark() });
      });
      /** Plays the recording's next tick, or checks its end. */
      const advance = Effect.fnUntraced(function* () {
        yield* keep();
        const diverged = stepper.done
          ? yield* stepper.finish()
          : yield* stepper.step();
        if (diverged !== undefined) {
          return yield* diverged;
        }
        ended = stepper.done;
      });
      const tick = Effect.fnUntraced(function* () {
        if (paused || ended) {
          return false;
        }
        owed += rate;
        let ran = false;
        while (owed >= 1 && !ended) {
          owed--;
          yield* advance();
          ran = true;
        }
        return ran;
      });
      const seek = Effect.fnUntraced(function* (to: number) {
        const target = Math.max(start, Math.min(end, Math.floor(to)));
        if (target < app.time.tick) {
          const from = kept.findLast((one) => one.tick <= target)!;
          yield* Timeline.rewind(app, from.moment);
          stepper.restore(from.mark);
          ended = false;
        }
        while (app.time.tick < target) {
          yield* advance();
        }
        owed = 0;
        // What it went past isn't heard: the frame stage draws where it is.
        const { events } = partsOf(app);
        events.ended("frame", app.time.tick);
        events.ended("input", app.time.tick);
      });
      const player: Player<A, E> = {
        app,
        recording,
        hz: 1 / (recording.deltas[0]?.delta ?? 1 / 60),
        get paused() {
          return paused;
        },
        get rate() {
          return rate;
        },
        get ended() {
          return ended;
        },
        tick,
        frame: (alpha, delta) => app.frame(alpha, delta),
        play: (given = 1) =>
          Effect.sync(() => {
            if (!(given > 0 && Number.isFinite(given))) {
              throw new Error(
                `A player was told to play at ${given} times its pace: a positive number, 1 for its own.`
              );
            }
            rate = given;
            paused = false;
          }),
        pause: Effect.sync(() => {
          paused = true;
        }),
        seek,
        close: app.close,
      };
      return Effect.as(keep(), player);
    })
  );
