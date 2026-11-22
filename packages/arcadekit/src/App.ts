/**
 * The app ties the pieces together: a world, the built-in services, plugins, an
 * ordered list of systems, action handlers, and a `tick`.
 *
 * Services come from plugins' layers. Anything systems and handlers need that
 * no plugin provides is an ordinary Effect requirement of `App.make`:
 *
 *   App.make({ plugins, systems }).pipe(Effect.provide(AudioLive))
 *
 * and a missing one is the usual Effect compile error.
 *
 * One tick:
 *   1. apply queued actions (refused ones become `Action.Rejected` events)
 *   2. advance game time
 *   3. inside ONE fiber: enter any requested states, running their exit and
 *      enter hooks; then run every system in order, except those whose
 *      condition doesn't hold, applying queued commands after each
 *   4. drop events everyone has seen
 *
 * The world's hash is recorded in the action log before the first action or
 * tick, and at the end of every `checkpointEvery`th tick.
 *
 * Between ticks, `frame` runs the frame-stage systems, which draw the game with
 * the world frozen, so they can't change it, and receive how far the frame is
 * between two ticks. `input`, just before a tick, runs the input-stage systems,
 * which receive the devices' state and turn it into actions, also with the
 * world frozen.
 *
 * An app made where the program provides a tracer, such as `OtlpTracer.layer`
 * of `effect/observability`, sends what it does as spans at the "Debug" level:
 * one for each tick, `arcadekit/tick`, holding a span for each action applied
 * in it, `action:<name>`, and for each system's turn, named after the system;
 * and one for each run of the frame stage, `arcadekit/frame`, and of the input
 * stage, `arcadekit/input`, holding their systems'. Each starts a trace of its
 * own. A span costs about 3 µs. An app makes none, and costs nothing, when no
 * tracer is provided, under `Effect.withTracerEnabled(false)`, or when
 * `Tracer.MinimumTraceLevel` is above "Debug": a program that sends spans of
 * its own and not the game's provides it as "Info". A span reads the real
 * clock and draws its ids from `Math.random`, so tracing doesn't change the
 * game.
 */
import {
  Cause,
  Clock,
  Context,
  Data,
  Effect,
  Random as EffectRandom,
  Exit,
  Layer,
  LogLevel,
  Metric,
  References,
  Result,
  Schema,
  Tracer,
} from "effect";
import type { Fiber, Scope } from "effect";
import * as Scheduler from "effect/Scheduler";

import * as Action from "./Action";
import * as Driver from "./Driver";
import type { SavedChanges } from "./ecs/changes";
import { CommandBuffer } from "./ecs/commands";
import { Component, Field } from "./ecs/component";
import type { Entity } from "./ecs/component";
import { Rng } from "./ecs/random";
import { SnapshotError, readSingleton } from "./ecs/snapshot";
import { isPlain } from "./ecs/store";
import type { Store } from "./ecs/store";
import { World as EcsWorld } from "./ecs/world";
import type { Moment as WorldMoment } from "./ecs/world";
import { EventBus } from "./Event";
import type { Told } from "./Event";
import * as Input from "./Input";
import * as Plugin from "./Plugin";
import * as Save from "./Save";
import {
  Commands,
  Events,
  Frame,
  Random,
  Ticks,
  Time,
  World,
} from "./Services";
import type { BuiltIn, FrameState, TimeState } from "./Services";
import * as State from "./State";
import * as System from "./System";
import { TickDispatcher, TickScheduler } from "./TickScheduler";

/**
 * A game's time, held by its world so that a snapshot, a restore and the
 * world's hash cover it, as Bevy keeps `Time` in its `World`. `Time` reads it.
 */
const GameTime = Component.singleton(
  "arcadekit/Time",
  { tick: Field.f64, elapsed: Field.f64, delta: Field.f64 },
  { tick: 0, elapsed: 0, delta: 0 }
);

/** The tick a save was made at, which its world holds. */
const tickOf = (save: Save.Save): number => {
  const tick = readSingleton(save.world, GameTime.component.name)?.columns
    .tick?.[0];
  return typeof tick === "number" ? tick : 0;
};

type Systems = readonly Plugin.AnySystem[];
type Handlers = readonly Plugin.AnyHandler[];
type Plugins = readonly Plugin.Any[];

// Distributive on purpose: an empty list must give `never`, not `unknown`.
type SystemError<T> = T extends System.System<infer E, unknown> ? E : never;
type SystemNeeds<T> = T extends System.System<unknown, infer R> ? R : never;
type HandlerNeeds<T> =
  T extends Action.Handler<string, infer _P, unknown, unknown, infer R>
    ? R
    : never;

type TickError<S extends Systems, P extends Plugins> =
  | SystemError<S[number]>
  | Plugin.TickErrorOf<P[number]>;
type AllHandlers<H extends Handlers, P extends Plugins> =
  | H[number]
  | Plugin.HandlerOf<P[number]>;
type Provided<P extends Plugins> = Plugin.ProvidedOf<P[number]>;

/**
 * What must come from outside: whatever systems, handlers and setups need that
 * neither a plugin nor the app provides, plus whatever plugin layers need that
 * their declared dependencies don't provide.
 */
type External<S extends Systems, H extends Handlers, P extends Plugins> =
  | Exclude<
      | SystemNeeds<S[number]>
      | HandlerNeeds<H[number]>
      | Plugin.NeedsOf<P[number]>,
      Provided<P> | BuiltIn
    >
  | Exclude<Plugin.LayerNeedsOf<P[number]>, BuiltIn>;

/** The names of the actions an app has handlers for. `HU` is a union of handlers. */
type ActionNames<HU> = HU extends Plugin.AnyHandler
  ? HU["action"]["name"]
  : never;
type HandlerFor<HU, N extends string> =
  HU extends Action.Handler<N, infer _P, unknown, unknown, unknown>
    ? HU
    : never;
type PayloadFor<HU, N extends string> =
  HandlerFor<HU, N> extends Action.Handler<
    string,
    infer P,
    unknown,
    unknown,
    unknown
  >
    ? P
    : never;
type ResultFor<HU, N extends string> =
  HandlerFor<HU, N> extends Action.Handler<
    string,
    infer _P,
    infer A,
    unknown,
    unknown
  >
    ? A
    : never;
type FailureFor<HU, N extends string> =
  HandlerFor<HU, N> extends Action.Handler<
    string,
    infer _P,
    unknown,
    infer E,
    unknown
  >
    ? E
    : never;

/**
 * What an app is running: `app.phase`.
 *
 * - `"idle"`: nothing. The app is between ticks.
 * - `"tick"`: a tick, the handlers of the actions it applies included.
 * - `"frame"`: the frame stage.
 * - `"input"`: the input stage.
 * - `"handler"`: an action's handler that `dispatch` runs, between ticks.
 *
 * @category Models
 */
export type Phase = "idle" | "tick" | "frame" | "input" | "handler";

/**
 * The part of an app that doesn't depend on its systems or handlers. Every app
 * satisfies it, so use it for code that works with any app.
 *
 * @category Models
 */
export interface Any {
  readonly world: EcsWorld;
  readonly commands: CommandBuffer;
  readonly events: EventBus;
  readonly time: Readonly<TimeState>;
  readonly dispatcher: TickDispatcher;
  /** Installed plugin names, dependencies first. */
  readonly plugins: readonly string[];
  /** System names in the order they run. */
  readonly systemOrder: readonly string[];
  /** The names of the frame-stage systems, in the order they run. */
  readonly frameOrder: readonly string[];
  /** The names of the input-stage systems, in the order they run. */
  readonly inputOrder: readonly string[];
  /**
   * What the app is running right now. A game is stepped, saved, captured,
   * put back, recorded, checkpointed and inspected in `"idle"` alone: each of
   * those throws in any other phase, a handler that `dispatch` runs included,
   * whose work is taken back if it is refused.
   */
  readonly phase: Phase;
  /**
   * Runs one tick. Throws if a system fails, or if a fiber started during the
   * tick is still running when it ends: one forked with `Effect.forkDetach`,
   * `Effect.forkIn` or into a scope of its own, which would change the game at
   * a moment no replay repeats.
   *
   * A tick reads the devices first: if the input stage hasn't run since the
   * previous tick, it runs now, as a driver would have run it, so a game that
   * steps its app by hand doesn't need to call `app.input()`. `{ input: false
   * }` runs a tick that reads nothing, for re-running a game from its log,
   * where every action is already recorded: `App.replay` ticks this way.
   */
  readonly tick: (delta: number, options?: TickOptions) => void;
  /**
   * Whether the game is at rest: a tick now would find no pending work. It is
   * false while an action is queued, a state transition is pending, a fiber is
   * due, or an event is waiting that some system hasn't had a chance to read. Reading it changes
   * nothing.
   *
   * A driver set to tick only when needed checks it, so a game that moves only
   * when its player does stands still in between. A system that acts every tick
   * while a condition of its own holds isn't visible unless it signals so, with
   * `Ticks.more`, each tick it has more to do; and an app that hasn't ticked
   * yet, new or just loaded, isn't settled, so every system gets a tick to
   * signal.
   */
  readonly settled: boolean;
  /**
   * Runs the frame stage once: the systems made with `System.inStage("frame")`,
   * which draw the game as it is between two ticks. `alpha` is how far between
   * them the frame is, from 0 just after a tick up to 1 just before the next,
   * and `delta` the real seconds since the previous frame; both reach the
   * systems as the `Frame` service. A driver calls this after each frame's
   * ticks.
   *
   * The world is frozen while it runs, and anything that would change the game
   * throws. Throws if a system fails, or leaves a fiber running, as for `tick`.
   * Only between ticks.
   */
  readonly frame: (alpha: number, delta?: number) => void;
  /**
   * Runs the input stage once: the systems made with `System.inStage("input")`,
   * which turn the devices' state into actions. The devices are read once,
   * here, and the systems receive that single sample as `Input.Devices`. What
   * they issue with `Actions.enqueue` is logged and applied at the start of the
   * next tick. A driver calls this just before each tick, and a tick that finds
   * it wasn't called since the previous tick runs it itself. A replay does
   * neither, since the actions are in its log.
   *
   * The world is frozen while it runs, as for `frame`. Throws if a system
   * fails, or leaves a fiber running, as for `tick`. Only between ticks.
   */
  readonly input: () => void;
  /**
   * Like `dispatch`, for actions that arrive as data: network messages, saved
   * games, replays. The payload is expected in its JSON form and validated
   * against the action's schema; an unknown name or an invalid payload is a
   * failure, `Action.UnknownAction` or `Action.InvalidPayload`, never a crash.
   * `from` names the issuer, as for `enqueueByName`.
   */
  readonly dispatchByName: (
    name: string,
    payload: unknown,
    from?: string
  ) => Exit.Exit<unknown, unknown>;
  /**
   * Like `enqueue`, for actions that arrive as data, and logged as `enqueue`
   * is, by where it is called. Problems become `Action.Rejected` events.
   *
   * `from` names the issuer, for code that brings actions in on someone else's
   * behalf, such as a server for its clients: the handler receives it, and the
   * log records it. Don't use it on an app in a session, where each peer's
   * actions are stamped with that peer's own name.
   */
  readonly enqueueByName: (
    name: string,
    payload: unknown,
    from?: string
  ) => void;
  /**
   * Everything that entered the game from outside, in arrival order,
   * interleaved with checkpoints of the world's hash: every dispatched action
   * that was accepted, and every action enqueued through the app, whatever its
   * outcome. Actions a system, a handler or a plugin's setup
   * enqueued aren't here, because a replay's own simulation issues them again. It is enough to replay the game, and to verify the replay.
   */
  readonly actionLog: readonly Action.LogEntry[];
  /**
   * The game as it was played, to replay with `App.replay`: the action log,
   * the delta of every tick, and the ticks it begins and ends at. It begins
   * where this app began, or at `since`, a save this app made, so that loading
   * that save and replaying the recording returns to the present. Only between
   * ticks.
   */
  readonly record: (since?: Save.Save) => Recording;
  /**
   * Saves the game as it is, to load later with `App.load`: the world, the
   * time, the actions queued for the next tick, the events waiting to be read,
   * what change queries haven't visited yet, and the length of the log. Only
   * between ticks.
   *
   * Fails with `SaveRefused`, which names what is in the way: a queued action
   * or a waiting event whose payload its schema doesn't take, a field holding a
   * value that can't be saved, or commands queued but not applied.
   */
  readonly save: () => Exit.Exit<Save.Save, Save.SaveRefused>;
  /**
   * Captures the game as it is, in memory, to return to with `rewind`: the
   * world with its time, the actions queued for the next tick, the events waiting
   * to be read with every reader's position, what change queries haven't
   * visited yet, and the length of the log. Only between ticks.
   *
   * It isn't a save. It holds the queued actions and events as they are, so
   * none of them needs a schema, and it belongs to this app in this run of the
   * program only. It is the building block for predicting a tick and
   * resimulating it: `Rollback` captures before each uncertain tick.
   *
   * Fails with `SaveRefused` when the world can't be snapshotted: a field holds
   * a value that can't be saved, or commands are queued but not applied.
   */
  readonly capture: () => Exit.Exit<Moment, Save.SaveRefused>;
  /**
   * Restores the game, in place, to when `moment` was captured: the same app,
   * world and services, holding what they held then. The log is truncated to
   * its length at that time. Only between ticks, and only with a moment of this
   * app.
   *
   * A moment holds what a save holds, and no more. State held by your game's own services is left as is: `Rollback.syncTest` finds a tick that reads it. A
   * `transient` field is undefined afterwards. And what runs between ticks
   * starts over: frame-stage and input-stage change queries visit everything
   * again.
   *
   * The frame and input stages don't hear an event twice: until the game has
   * run again the ticks it had run before the rewind, an event of theirs that
   * a stage heard then, the same payload, is heard once. An event the ticks
   * run again emit otherwise, or a payload that changed, is heard as new.
   */
  readonly rewind: (moment: Moment) => void;
  /**
   * Records the world's hash in the action log now, and returns it. Use it for
   * points the game wants verified beyond the ones `checkpointEvery` records,
   * such as when it is saved. Only between ticks.
   */
  readonly checkpoint: () => number;
  /**
   * Copies what the game holds and what it did last, as plain data to read in
   * a debugger or the console, or to show in a game's own UI: its entities and
   * their components, its singletons, its systems with how long each took,
   * and the events of the last tick. See `Inspection`. Reading it changes
   * nothing.
   *
   * **Gotchas**
   *
   * - It copies the whole world, so call it when you look rather than every
   *   frame.
   * - It throws during a tick or a frame: inspect between ticks.
   */
  readonly inspect: () => Inspection;
}

/**
 * What a game holds and what it did last, as `app.inspect()` copies it. Every
 * value is a plain object or array, a copy, which can be kept, logged or shown
 * without changing the game.
 *
 * @category Models
 */
export interface Inspection {
  /** The number of ticks run. */
  readonly tick: number;
  /**
   * Every live entity, in order of index, with a copy of each of its
   * components' fields by component name.
   */
  readonly entities: readonly {
    readonly id: Entity;
    readonly components: Readonly<Record<string, object>>;
  }[];
  /** A copy of each singleton the world holds, by name. */
  readonly singletons: Readonly<Record<string, object>>;
  /**
   * What the game holds beside its entities and singletons, as plain data,
   * by the name of the store that holds it: under `App.INTAKE`, the actions
   * queued for the next tick, as `{ queued, heard }`, and under
   * `Event.STORE`, the events waiting to be read, by event name. A store that
   * holds nothing isn't listed.
   */
  readonly stores: Readonly<Record<string, unknown>>;
  /**
   * Every system: the tick's in the order they run, then the hooks, the input
   * stage's and the frame stages'. Each has what its last turn was: whether
   * it ran, false when a condition given with `System.runIf` didn't hold or
   * when it hasn't had a turn yet, and how long the turn took in
   * milliseconds, its condition and its commands included.
   */
  readonly systems: readonly {
    readonly name: string;
    readonly stage: System.Stage;
    readonly ran: boolean;
    readonly ms: number;
  }[];
  /**
   * The events emitted in the last tick, and between it and the tick before,
   * by event name, each in the order it was emitted. An event emitted by an
   * action dispatched since is not here yet: it is in the next tick's.
   */
  readonly events: Readonly<Record<string, readonly unknown[]>>;
}

const NO_INPUT: TickOptions = { input: false };

/**
 * A game at one moment, held in memory: what `app.capture()` returns and
 * `app.rewind()` takes. It exposes its tick; the rest is internal to the app.
 *
 * @category Models
 */
export interface Moment {
  /** The number of ticks run when it was captured. */
  readonly tick: number;
}

/**
 * A game as it was played, from `app.record()`, for `App.replay` to play
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
export const encodeRecording = (recording: Recording): string =>
  JSON.stringify(recording);

/**
 * Decodes a recording from text. It checks the recording's own structure:
 * that its runs of deltas and its log are in order and within it. Each payload
 * is validated against its action's schema, and each checkpoint against the
 * world, when it is replayed.
 *
 * @category Codecs
 */
export const decodeRecording = (
  text: string
): Exit.Exit<Recording, Schema.SchemaError> =>
  Schema.decodeExit(RecordingSchema)(text);

/**
 * Options for running a tick.
 *
 * @category Options
 */
export interface TickOptions {
  /**
   * Whether the tick first runs the input stage, if it hasn't run since the
   * previous tick. Defaults to true. False for a tick that must read no device
   * and receive no UI input: a replay's, or a simulation re-run from a log.
   */
  readonly input?: boolean;
}

/**
 * What `divert` returns to the code that took over an app: the two operations
 * the app no longer performs for anyone else.
 *
 * @category Models
 */
export interface Diverted<E = never> {
  /**
   * Queues an action for the next tick and logs it, as `enqueueByName` did: by
   * name, with its payload in JSON form, and with its issuer.
   */
  readonly deliver: (name: string, payload: unknown, from?: string) => void;
  /**
   * Runs one tick, as `tickExit` did. It reads no device. `observe` is told
   * when the tick's systems are about to run, with no name, and after each
   * system has run and its commands are applied, with the system's name.
   */
  readonly tickExit: (
    delta: number,
    observe?: (system: string | undefined) => void
  ) => Exit.Exit<void, E>;
  /**
   * Captures the game, as `capture` does, for a rewind that comes before the
   * frame and input stages run again. It keeps their place in what changed
   * too, so the rewind puts them back exactly, where `capture`'s moment has
   * them see everything again. A stage that runs between the two sees again
   * what changed since.
   */
  readonly capture: () => Exit.Exit<Moment, Save.SaveRefused>;
  /**
   * Puts the game back to a moment, as `rewind` does, to run the same ticks
   * again with what is now known of them. The frame and input stages hear
   * each event once across it: an event a tick emits again, with the same
   * payload, isn't heard twice, and only what the tick now does otherwise
   * is. After `app.rewind`, which goes back to play on from there, every
   * event is new to them.
   */
  readonly rewind: (moment: Moment) => void;
}

/**
 * A running game: its world, its time, the actions queued for the next tick,
 * and what runs a tick and a frame. Made with `App.make`, `App.load` or, in a
 * page, `App.run`.
 *
 * `E` is what a tick can fail with, and `HU` the actions its handlers accept.
 *
 * @category Models
 */
export interface App<E = never, HU = never> extends Any {
  /**
   * Takes over the app, for code that decides on which tick an action is
   * applied and when a tick runs: a multiplayer session, where every peer must
   * apply the same actions on the same ticks.
   *
   * From then on, an action enqueued from outside isn't queued for the next
   * tick. It is passed to `take`, by name and with its payload in JSON form:
   * any action given to `enqueue` or `enqueueByName`, and any issued with
   * `Actions.enqueue` in the input or frame stage, so key bindings and UI
   * buttons are covered too. What the simulation issues itself isn't passed on,
   * since every peer's simulation issues it.
   *
   * The returned object is the only remaining way to queue an action and to run
   * a tick. `tick`, `tickExit`, `dispatch` and `dispatchByName` throw from then
   * on, since each would advance this machine's game and no one else's. An app
   * can be taken over once.
   */
  readonly divert: (
    take: (name: string, payload: unknown) => void
  ) => Diverted<E>;
  /**
   * Runs one tick and returns the outcome, with system failures as a typed
   * `Exit`.
   */
  readonly tickExit: (
    delta: number,
    options?: TickOptions
  ) => Exit.Exit<void, E>;
  /** Like `frame`, but returns the outcome, with a system's failure typed. */
  readonly frameExit: (alpha: number, delta?: number) => Exit.Exit<void, E>;
  /** Like `input`, but returns the outcome, with a system's failure typed. */
  readonly inputExit: () => Exit.Exit<void, E>;
  /**
   * Applies an action now and returns the outcome. A refusal comes back as a
   * typed failure and leaves the game unchanged. An accepted action is logged;
   * a refused one isn't.
   *
   * For code outside the simulation, and only between ticks: it throws during a
   * tick, during the frame or input stage, and from a handler. It also throws
   * on an app a session has taken over, where it would advance this machine's
   * game alone: use `enqueue` instead. A handler that leaves a fiber running,
   * as `tick` refuses, throws too, with its changes undone.
   */
  readonly dispatch: <N extends ActionNames<HU>>(
    action: Action.ActionDef<N, PayloadFor<HU, N>>,
    payload: PayloadFor<HU, N>
  ) => Exit.Exit<ResultFor<HU, N>, FailureFor<HU, N>>;
  /**
   * Queues an action for the start of the next tick. A refusal when it is
   * applied becomes an `Action.Rejected` event. It is the same as
   * `Actions.enqueue`, and works from anywhere.
   *
   * Where it is called decides whether it is logged. From outside the
   * simulation, between ticks, the action is input: it is logged, a refusal is
   * marked on its log entry, and on an app a session has taken over it goes to
   * every peer. From a system, a handler or a
   * plugin's setup, it is the simulation's own move: it isn't
   * logged, since a replay's own simulation makes it again.
   *
   * Fails with `Action.InvalidPayload`, and queues nothing, when the action's
   * schema does not take the payload of input: it could not be logged or sent
   * to the other peers.
   */
  readonly enqueue: <N extends ActionNames<HU>>(
    action: Action.ActionDef<N, PayloadFor<HU, N>>,
    payload: PayloadFor<HU, N>
  ) => Exit.Exit<void, Action.InvalidPayload>;
}

/**
 * A system as the app runs it: its condition, then its run or what it
 * does in place of running, in a span of its own when the app traces.
 * Made once, so an app that doesn't trace runs what it would without.
 * What its last turn was is kept for `inspect`.
 */
class Turn {
  /** Asked before `run`, unless the span holds it. */
  readonly condition: Effect.Effect<boolean, unknown, unknown> | undefined;
  readonly idle: Effect.Effect<void, unknown, unknown> | undefined;
  readonly run: Effect.Effect<void, unknown, unknown>;
  ran = false;
  ms = 0;
  constructor(
    readonly system: Plugin.AnySystem,
    trace: boolean
  ) {
    const { condition, idle, run } = system;
    if (!trace) {
      // Asked in the loop, which is cheaper than a flatMap each tick.
      this.condition = condition;
      this.idle = idle;
      this.run = run;
      return;
    }
    this.condition = undefined;
    this.idle = undefined;
    this.run = Effect.withSpan(
      condition === undefined
        ? run
        : Effect.flatMap(condition, (holds) => {
            this.ran = holds;
            return holds ? run : (idle ?? Effect.void);
          }),
      system.name,
      { level: System.spanLevel }
    );
  }
}

/**
 * The prefix of a reader's name in the world's change logs when it is a
 * system of the frame stage or the input stage. Such a reader isn't part of
 * the simulation: its place in what changed isn't saved.
 */
const FRAME_READER = "frame:";

/** Summarizes an error in a few words, for a log entry or a message. */
const describe = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

/** An action waiting for the next tick. */
interface QueuedAction {
  readonly name: string;
  readonly payload: unknown;
  /**
   * The action's codec, while the payload is the value a handler works with.
   * Undefined for one in the JSON form that arrives from outside, which is
   * checked when it is applied.
   */
  readonly codec: Schema.Codec<unknown, unknown> | undefined;
  /**
   * The log entry of an action enqueued from outside the simulation, told
   * its fate when it is applied. One that a system or a handler issued has
   * none.
   */
  readonly entry: { refused?: string } | undefined;
  /** The issuer, if it came with a name. */
  readonly from: string | undefined;
}

/** A payload's JSON form, or `null` when its action's schema doesn't take it. */
const jsonOf = ({ codec, payload }: QueuedAction): unknown => {
  if (codec === undefined) {
    return payload;
  }
  const json = Schema.encodeUnknownExit(codec)(payload);
  return Exit.isSuccess(json) ? json.value : null;
};

/** What a snapshot holds of the intake: `Intake.save`. */
const IntakeData = Schema.Struct({
  queued: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      payload: Schema.Unknown,
      from: Schema.optionalKey(Schema.String),
    })
  ),
  heard: Schema.Boolean,
});

/** What the intake holds at a moment: the actions as they are, with no schema. */
interface IntakeMoment {
  readonly queued: readonly QueuedAction[];
  readonly heard: boolean;
}

/**
 * The name of the store that holds an app's queued actions, as a snapshot
 * has it: `readSnapshot(save.world).stores`. It holds `{ queued, heard }`:
 * the actions queued for the next tick, each `{ name, payload, from? }` with
 * its payload in JSON form, and whether the input stage has run since the
 * last tick.
 *
 * @category Constants
 */
export const INTAKE = "arcadekit/actions";

/**
 * What a game has taken in for its next tick: the actions queued for it, and
 * whether the input stage has run since the last one, so that a game that
 * is saved, loaded or rewound between the two doesn't hear its devices
 * twice. They are the game's as much as its components are, so the world
 * holds them, as a store: its snapshot, its hash and a rewind cover them, and
 * a refused action's own enqueues are taken back with the rest of it.
 */
class Intake implements Store<IntakeMoment> {
  readonly name = INTAKE;
  // The stages between ticks are there to issue actions.
  readonly betweenTicks = true;
  queued: QueuedAction[] = [];
  heard = false;
  private txLength = 0;

  /** Takes every queued action, for the tick that applies them. */
  take(): QueuedAction[] {
    const { queued } = this;
    this.queued = [];
    return queued;
  }

  save(): unknown {
    if (this.queued.length === 0 && !this.heard) {
      return undefined;
    }
    const queued = this.queued.map(({ codec, from, name, payload }) => {
      let json = payload;
      if (codec !== undefined) {
        const exit = Schema.encodeUnknownExit(codec)(payload);
        if (Exit.isFailure(exit)) {
          throw new SnapshotError(
            "cannot be saved",
            `Can't save the actions queued for the next tick: the action "${name}" has a payload its schema does not take: ${describe(Cause.squash(exit.cause))}`
          );
        }
        json = exit.value;
      }
      if (!isPlain(json)) {
        throw new SnapshotError(
          "cannot be saved",
          `Can't save the actions queued for the next tick: the payload of the action "${name}" is not plain data.`
        );
      }
      return from === undefined
        ? { name, payload: json }
        : { name, payload: json, from };
    });
    return { queued, heard: this.heard };
  }

  load(data: unknown): void {
    const saved = Schema.decodeUnknownExit(IntakeData)(data);
    if (Exit.isFailure(saved)) {
      throw new SnapshotError(
        "store changed",
        `Can't load the actions queued for the next tick: they are not { queued, heard }, with each action { name, payload, from? }: ${describe(Cause.squash(saved.cause))}`
      );
    }
    // In the JSON form they were saved in, checked again when applied.
    this.queued = saved.value.queued.map(({ from, name, payload }) => ({
      name,
      payload,
      codec: undefined,
      entry: undefined,
      from,
    }));
    this.heard = saved.value.heard;
  }

  hashed(): unknown {
    // Not whether the devices were heard: hearing them changes nothing of
    // the game but what it queues.
    return this.queued.length === 0
      ? undefined
      : this.queued.map((action) => ({
          name: action.name,
          payload: jsonOf(action),
          from: action.from ?? null,
        }));
  }

  capture(): IntakeMoment {
    return { queued: this.queued.slice(), heard: this.heard };
  }

  rewind(moment: IntakeMoment): void {
    this.queued = moment.queued.slice();
    this.heard = moment.heard;
    for (const action of this.queued) {
      // It is waiting again: what became of it has not happened.
      if (action.entry !== undefined) {
        delete action.entry.refused;
      }
    }
  }

  clear(): void {
    this.queued = [];
    this.heard = false;
  }

  begin(): void {
    this.txLength = this.queued.length;
  }

  rollback(): void {
    this.queued.length = this.txLength;
  }

  commit(): void {}

  contents(): unknown {
    return this.queued.length === 0 && !this.heard
      ? undefined
      : { queued: this.hashed() ?? [], heard: this.heard };
  }
}

/** Why an action was refused, as `Action.Rejected` carries it. */
const refusal = (error: unknown): { _tag: string; message: string } => {
  const tag =
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
      ? error._tag
      : error instanceof Error
        ? error.name
        : "Error";
  return {
    _tag: tag,
    message: error instanceof Error ? error.message : String(error),
  };
};

/**
 * A frame-stage or input-stage system changed the world, which it must not do,
 * as detected by an app created with `verifyFrames`. It is a defect, not a
 * failure to handle: those stages run between ticks, and a game that depends on
 * having been drawn, or on its devices having been read, doesn't replay.
 *
 * @category Errors
 */
export class FrameChangedWorld extends Data.TaggedError("FrameChangedWorld")<{
  /** The stage the system belongs to. */
  readonly stage: "frame" | "input";
  /** The system after which the world had changed. */
  readonly system: string;
  /** The frame number, counted from 1: for the input stage, the last frame drawn. */
  readonly frame: number;
}> {
  override get message(): string {
    return `The ${this.stage} stage changed the world: its hash was not the same after system "${this.system}" ran${this.stage === "frame" ? ` in frame ${this.frame}` : ""} as before. ${this.stage === "frame" ? "The frame stage draws the game between two ticks" : "The input stage reads the devices before a tick"} and must leave the world as it found it. Look for a write through the raw columns of eachChunk, which nothing stops where it is made, or a draw from world.random, which is otherwise only found when the stage ends.`;
  }
}

/**
 * Options for creating an app, as `App.make` and `App.load` take them: its
 * plugins, its own systems, handlers and components, and its version.
 *
 * @category Options
 */
export interface Options<
  S extends Systems = readonly [],
  H extends Handlers = readonly [],
  P extends Plugins = readonly [],
> {
  readonly plugins?: readonly [...P];
  /**
   * The game's version: an integer you increment when the game changes its
   * components or what its saves contain. Defaults to 0. A save records it.
   * `App.load` loads a save of this version as is, migrates an older one with
   * `migrations`, and refuses a newer one.
   */
  readonly version?: number;
  /**
   * How a save of an older version becomes one of the next: one migration per
   * version, each from `from` to `from + 1`. Only `App.load` uses them.
   */
  readonly migrations?: readonly Save.Migration[];
  /** Systems and handlers that belong to the app itself, not to a plugin. */
  readonly systems?: readonly [...S];
  readonly handlers?: readonly [...H];
  /**
   * Where the app's random sequence starts: an integer from 0 to
   * `Number.MAX_SAFE_INTEGER`. Defaults to 0. Two apps with the same seed draw
   * the same numbers from `Random`, and a replay needs the seed its game was
   * played with.
   */
  readonly seed?: number;
  /**
   * How often the world's hash is recorded in the action log: at the end of
   * every tick whose number is a multiple of this, and once before the first
   * action or tick. A replay compares its own world at each of these, so a
   * smaller number catches divergence closer to where it happened, at the cost
   * of one world hash each time. Defaults to 60. A turn-based game wants 1; 0
   * records none.
   */
  readonly checkpointEvery?: number;
  /**
   * Verifies that the frame and input stages leave the world unchanged: the
   * world's hash, without the actions queued for the next tick, which those
   * stages are there to issue, is taken before the stage and after each of its
   * systems, and
   * `frame` dies with `FrameChangedWorld`, naming the system, if they differ.
   * Most ways to change the world from those stages already throw where they
   * happen, and a draw from `world.random` is detected at the end of the frame
   * either way. This catches the remaining one, a write through raw columns,
   * and names the system responsible for either. It costs one world hash per
   * frame system per frame, so use it in development and tests.
   */
  readonly verifyFrames?: boolean;
}

/**
 * Starts a fresh game: every plugin's `setup` runs.
 *
 * @category Constructors
 */
export const make = <
  S extends Systems = readonly [],
  H extends Handlers = readonly [],
  P extends Plugins = readonly [],
>(
  options: Options<S, H, P>
): Effect.Effect<
  App<TickError<S, P>, AllHandlers<H, P>>,
  Plugin.ErrorOf<P[number]>,
  Scope.Scope | External<S, H, P>
> =>
  build(options, undefined) as Effect.Effect<
    App<TickError<S, P>, AllHandlers<H, P>>,
    Plugin.ErrorOf<P[number]>,
    Scope.Scope | External<S, H, P>
  >;

/**
 * Restores a game from a save: its world, its time, the actions queued for the
 * next tick and the events waiting to be read. Pass the plugins and options the
 * game was created with.
 *
 * No plugin's `setup` runs, since the save holds what setup spawned.
 *
 * The app's action log starts empty. To return to where the game had got to,
 * replay what it recorded since the save, `app.record(save)`, with
 * `App.replay`, which verifies it against the log's checkpoints as it goes.
 *
 * Fails with `LoadRefused` when the save's world can't be loaded: it contains a
 * component this program doesn't define, or one whose fields have changed, or its bytes are
 * damaged. It also fails when the save is from another version of the game and
 * `migrations` don't bring it up to this one: see `Save.migrate`.
 *
 * **Gotchas**
 *
 * - State held by your game's own services isn't in the save, and a `transient`
 *   field is undefined afterwards.
 *
 * @category Constructors
 */
export const load = <
  S extends Systems = readonly [],
  H extends Handlers = readonly [],
  P extends Plugins = readonly [],
>(
  save: Save.Save,
  options: Options<S, H, P>
): Effect.Effect<
  App<TickError<S, P>, AllHandlers<H, P>>,
  Plugin.ErrorOf<P[number]> | Save.LoadRefused,
  Scope.Scope | External<S, H, P>
> => build(options, save);

/**
 * Options for how `App.run` drives the app it creates.
 *
 * @category Options
 */
export interface RunOptions<
  A,
  E2 = never,
  R2 = never,
  SV extends Save.Save | undefined = undefined,
> {
  /** The ticks per second the game runs at, whatever the frame rate. */
  readonly hz: number;
  /** The maximum ticks one frame runs after a stall. Defaults to 5. */
  readonly maxStepsPerCall?: number;
  /**
   * `"whenNeeded"` for a game that moves only when its player does: it is drawn
   * every frame, but only ticks while something is waiting for a tick, as
   * `Driver.frames` describes. Defaults to `"always"`, for a real-time game.
   */
  readonly ticks?: "always" | "whenNeeded";
  /**
   * A save to continue from, instead of a fresh start: the app is created with
   * `App.load`, and `run` can fail with `Save.LoadRefused`.
   */
  readonly save?: SV;
  /**
   * Runs once with the app, after it is created and before its first frame: to
   * connect things outside the game to it (a button that dispatches, a menu
   * that saves), or to keep a reference to it. Whatever it acquires is released
   * with the app, and its requirements and errors become `run`'s.
   */
  readonly ready?: (app: A) => Effect.Effect<void, E2, R2>;
}

/**
 * Creates the app and runs it until interrupted. This is the usual entry point.
 *
 *   Browser.runMain(App.run({ plugins: [Game] }, { hz: 60 }), { target: canvas })
 *
 * It is `App.make` and `Driver.frames` in a scope of their own: the app is
 * created, `ready` runs if given, and the frame loop follows the display,
 * running the ticks that are due at `hz`, then the frame stage, once per
 * repaint. It never ends on its own.
 *
 * Interrupting it stops the loop and closes that scope, so nothing is left
 * running: no pending frame, and everything the plugins' layers and
 * `ready` acquired is released. The platform's `runMain` interrupts it when the
 * page closes or the process is told to stop.
 *
 * Provide what the game needs from outside as you would to `App.make`; it stays
 * provided for as long as the game runs, which is what a listening layer such
 * as `Browser.layer` needs. It fails with what `App.make` and `ready` can fail
 * with, and dies with whatever a tick throws.
 *
 * It runs wherever there is a display, which outside a page is a timer:
 * `NodeRuntime.runMain(App.run(...))` runs the same game under Node.
 *
 * @category Running
 */
export const run = <
  S extends Systems = readonly [],
  H extends Handlers = readonly [],
  P extends Plugins = readonly [],
  E2 = never,
  R2 = never,
  SV extends Save.Save | undefined = undefined,
>(
  options: Options<S, H, P>,
  drive: RunOptions<App<TickError<S, P>, AllHandlers<H, P>>, E2, R2, SV>
): Effect.Effect<
  never,
  | Plugin.ErrorOf<P[number]>
  | E2
  | (SV extends Save.Save ? Save.LoadRefused : never),
  External<S, H, P> | Exclude<R2, Scope.Scope>
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const app = yield* build(options, drive.save);
      if (drive.ready !== undefined) {
        yield* drive.ready(app);
      }
      return yield* Driver.frames(app, drive);
    })
  ) as Effect.Effect<
    never,
    | Plugin.ErrorOf<P[number]>
    | E2
    | (SV extends Save.Save ? Save.LoadRefused : never),
    External<S, H, P> | Exclude<R2, Scope.Scope>
  >;

const build = <S extends Systems, H extends Handlers, P extends Plugins>(
  options: Options<S, H, P>,
  given: Save.Save | undefined
): Effect.Effect<
  App<TickError<S, P>, AllHandlers<H, P>>,
  Plugin.ErrorOf<P[number]> | Save.LoadRefused,
  Scope.Scope | External<S, H, P>
> =>
  Effect.gen(function* () {
    const world = new EcsWorld(
      options.seed === undefined ? undefined : { seed: options.seed }
    );
    const { random } = world;
    const commands = new CommandBuffer(world);
    const events = new EventBus(world);
    // Attached before the world loads a save, which may hold some of each.
    const intake = new Intake();
    world._attach(intake);
    const dispatcher = new TickDispatcher();
    const scheduler = new TickScheduler(dispatcher);

    // Dependencies first, each plugin once, then the app's own systems.
    const plugins = Plugin.flatten(options.plugins ?? []);
    const version = options.version ?? 0;
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error(
        `A game's version must be a whole number from 0 up, and this one is ${version}.`
      );
    }
    let save: Save.Save | undefined;
    if (given !== undefined) {
      // An older save is brought up to this version of the game first.
      const current = Save.migrate(given, version, options.migrations ?? []);
      if (Exit.isFailure(current)) {
        return yield* current;
      }
      save = current.value;
    }
    if (save !== undefined) {
      const { world: stored, changes } = save;
      // Before anything else can touch the world: a load fills an empty one.
      const loaded = Result.try(() => {
        world.load(stored);
        world.restoreChanges(changes);
      });
      if (Result.isFailure(loaded)) {
        const error = loaded.failure;
        if (!(error instanceof SnapshotError)) {
          return yield* Effect.die(error);
        }
        return yield* new Save.LoadRefused({
          problem: error.problem,
          message:
            error.problem === "unknown component"
              ? `${error.message} A migration renames or removes a component in a save.`
              : error.problem === "unknown store" ||
                  error.problem === "store changed"
                ? `${error.message} A migration changes the events and the queued actions of a save in \`world.stores\`.`
                : error.message,
        });
      }
    }
    // Loaded with the world, or written by the first tick.
    const time: TimeState = world.singleton(GameTime);
    const allSystems = [
      ...plugins.flatMap((plugin) => plugin.systems),
      ...(options.systems ?? []),
    ];
    const allHandlers = [
      ...plugins.flatMap((plugin) => plugin.handlers),
      ...(options.handlers ?? []),
    ];

    const handlers = new Map<string, Action.AnyHandler>();
    for (const handler of allHandlers) {
      if (handlers.has(handler.action.name)) {
        throw new Error(`Two handlers for action "${handler.action.name}"`);
      }
      handlers.set(handler.action.name, handler);
    }
    const actionLog: Action.LogEntry[] = [];
    // Where this app began, and the delta of every tick it has run since, in
    // runs: for a recording.
    const began = time.tick;
    const deltas: { tick: number; delta: number }[] = [];
    // The moments this app has captured: `rewind` takes no other.
    const moments = new WeakSet<Moment>();
    /** What a moment holds beyond its tick. */
    interface Captured extends Moment {
      readonly world: WorldMoment;
      /** Where the game was in what the stages between ticks were told. */
      readonly told: Told;
      readonly changes: SavedChanges[];
      readonly logLength: number;
      readonly wanted: boolean;
    }
    const checkpointEvery = options.checkpointEvery ?? 60;
    if (!Number.isSafeInteger(checkpointEvery) || checkpointEvery < 0) {
      throw new Error(
        `checkpointEvery must be a whole number of ticks, 0 for none, and this one is ${checkpointEvery}.`
      );
    }
    const checkpoint = (): number => {
      const hash = world.hash();
      actionLog.push({ tick: time.tick, hash });
      return hash;
    };
    // The state the game starts from is whatever the world holds when the
    // first action is applied or the first tick runs: setup and the caller
    // have spawned what they spawn by then. A replay checks it has the same.
    // A game has started once its log holds anything: a checkpoint the game
    // took by hand before starting already is the first one.
    const start = (): void => {
      if (checkpointEvery > 0 && actionLog.length === 0) {
        checkpoint();
      }
    };
    /**
     * Logs an action enqueued from outside as it arrives. Its outcome is
     * decided when it is applied, and a replay enqueues it again at the same
     * point and lets its own simulation decide.
     */
    const arrived = (
      name: string,
      payload: unknown,
      from: string | undefined
    ) => {
      start();
      const entry: {
        readonly tick: number;
        readonly name: string;
        readonly payload: unknown;
        readonly from?: string;
        readonly queued: true;
        refused?: string;
      } = {
        tick: time.tick,
        name,
        payload,
        ...(from === undefined ? {} : { from }),
        queued: true,
      };
      actionLog.push(entry);
      return entry;
    };
    const handles = (action: Action.AnyActionDef): boolean =>
      handlers.has(action.name);
    // Who has taken over what comes from outside, if anyone has: `divert`.
    let diverted: ((name: string, payload: unknown) => void) | undefined;
    /** Enqueues from outside the simulation: `app.enqueue`. */
    const enqueue = (
      action: Action.AnyActionDef,
      payload: unknown
    ): Exit.Exit<void, Action.InvalidPayload> => {
      const handler = handlers.get(action.name);
      if (handler === undefined) {
        throw new Error(`No handler for action "${action.name}"`);
      }
      // The log holds the JSON form, and the other peers are sent it. A
      // payload that has none is refused here, in a game of one too: queued,
      // it would be refused on this machine alone.
      const json = Schema.encodeUnknownExit(handler.action.codec)(payload);
      if (Exit.isFailure(json)) {
        return Exit.fail(
          new Action.InvalidPayload({
            action: action.name,
            message: describe(Cause.squash(json.cause)),
          })
        );
      }
      if (diverted !== undefined) {
        diverted(action.name, json.value);
        return Exit.void;
      }
      intake.queued.push({
        name: action.name,
        payload,
        codec: handler.action.codec,
        entry: arrived(action.name, json.value, undefined),
        from: undefined,
      });
      return Exit.void;
    };
    /** Queues an action that arrived as data for the next tick, and logs it. */
    const deliver = (name: string, payload: unknown, from?: string): void => {
      intake.queued.push({
        name,
        payload,
        codec: undefined,
        entry: arrived(name, payload, from),
        from,
      });
    };
    const enqueueByName = (
      name: string,
      payload: unknown,
      from?: string
    ): void => {
      if (diverted === undefined) {
        deliver(name, payload, from);
        return;
      }
      if (from !== undefined) {
        throw new Error(
          `enqueueByName("${name}") was given who issued it, "${from}", on an app that a session has taken over. What a peer issues is stamped with that peer's own name, by its session, and nobody speaks for another.`
        );
      }
      diverted(name, payload);
    };
    /**
     * Enqueues from inside the simulation: the `Actions` service. Not logged,
     * because a replay's own systems and handlers issue it again.
     */
    const enqueueFromInside = (
      action: Action.AnyActionDef,
      payload: unknown
    ): void => {
      if (!handlers.has(action.name)) {
        throw new Error(`No handler for action "${action.name}"`);
      }
      intake.queued.push({
        name: action.name,
        payload,
        codec: action.codec,
        entry: undefined,
        from: undefined,
      });
    };

    const frame: FrameState = { alpha: 0, delta: 0, count: 0 };
    const notInTick = (): never => {
      throw new Error(
        'Frame was read by a system that runs in the tick. It tells the frame stage how far a frame is between two ticks, in real time, which a simulation must not depend on: read Time instead, or move the system to the frame stage with System.inStage("frame").'
      );
    };
    const notInInput = (): never => {
      throw new Error(
        'Input.Devices was read outside the input stage. It is what the devices say now, which is no part of the game. A system that runs in the tick reads the picture the game has of them, Input.Keyboard, Input.Pointer or Input.Gamepad, and what turns the devices into actions is a system of the input stage, System.inStage("input").'
      );
    };
    const builtIns = Context.empty().pipe(
      Context.add(World, world),
      Context.add(Time, time),
      Context.add(Input.Devices, {
        get down() {
          return notInInput();
        },
        get pressed() {
          return notInInput();
        },
        get released() {
          return notInInput();
        },
        get axes() {
          return notInInput();
        },
        get moved() {
          return notInInput();
        },
      }),
      Context.add(Frame, {
        get alpha() {
          return notInTick();
        },
        get delta() {
          return notInTick();
        },
        get count() {
          return notInTick();
        },
      }),
      Context.add(Commands, commands),
      Context.add(Ticks, {
        more() {
          wanted = true;
        },
      }),
      Context.add(Events, events),
      Context.add(Action.Actions, {
        enqueue: (action, payload) => issue(action, payload),
        handles,
      }),
      Context.add(Random, random),
      // Effect's own Random draws from the same generator, so `Random.next`
      // from "effect", or anything built on it, is seeded and replayed too.
      Context.add(EffectRandom.Random, {
        // 53 random bits: the most a number between 0 and 1 can hold.
        nextDoubleUnsafe: () =>
          ((random.bits() >>> 5) * 67_108_864 + (random.bits() >>> 6)) /
          9_007_199_254_740_992,
        // Any safe integer, negative ones included.
        nextIntUnsafe: () => {
          const magnitude =
            (random.bits() >>> 11) * 4_294_967_296 + random.bits();
          return (random.bits() & 1) === 0 ? magnitude : -magnitude;
        },
      })
    );
    // Plugin layers are chained in dependency order, so each one can use the
    // built-in services and whatever the plugins before it provide. Effect
    // builds a layer that appears more than once only once.
    let layer: Layer.Layer<never, unknown, unknown> =
      Layer.succeedContext(builtIns);
    for (const plugin of plugins) {
      if (plugin.layer !== undefined) {
        layer = Layer.provideMerge(plugin.layer, layer);
      }
    }
    const built = yield* Layer.build(layer);
    // Everything the caller provided (their services, resource overrides, the
    // scope) is captured once here and handed to every system and handler.
    const provided = yield* Effect.context<External<S, H, P>>();
    // The system running now, or the last one that ran.
    let running = "";
    /**
     * While a tick runs for whoever took the app over and asked: told before
     * the tick's first system and after each one, with its name.
     */
    let observer: ((system: string | undefined) => void) | undefined;
    // Every fiber started with the app's services is counted when it starts
    // and when it ends, so that one still running after the code that
    // started it has finished is refused: it would change the game at a
    // moment no replay repeats. While a stage runs, the systems that start
    // fibers are noted, for the message.
    let fibers = 0;
    let notingStarters = false;
    let fiberStarters: Set<string> | undefined;
    const outerMetrics = Context.get(
      Context.merge(provided, built),
      Metric.FiberRuntimeMetrics
    );
    const fiberCount: Metric.FiberRuntimeMetricsService = {
      recordFiberStart(started) {
        fibers++;
        if (notingStarters && running !== "") {
          (fiberStarters ??= new Set()).add(running);
        }
        outerMetrics?.recordFiberStart(started);
      },
      recordFiberEnd(ended, exit) {
        fibers--;
        outerMetrics?.recordFiberEnd(ended, exit);
      },
    };
    /**
     * The error to throw when more fibers are running than `before`, once what
     * the dispatcher holds has run: `what` started a fiber and left it
     * running. The systems noted as starting fibers are forgotten.
     */
    const leftFibers = (before: number, what: string): Error | undefined => {
      dispatcher.flush();
      const left = fibers - before;
      const noted = fiberStarters;
      notingStarters = false;
      fiberStarters = undefined;
      if (left > 0) {
        const starters =
          noted === undefined
            ? ""
            : ` (started while ${[...noted].map((name) => `"${name}"`).join(", ")} ran)`;
        return new Error(
          `${what} left ${left === 1 ? "a fiber" : `${left} fibers`} running${starters}, with Effect.forkDetach, Effect.forkIn or another fork that outlives it. ` +
            `It would change the game later, at a moment no replay repeats. Wait for a fiber within the code that started it, ` +
            `or keep work that takes longer than a tick in the world, in a component or a state that a system moves on each tick.`
        );
      }
      return undefined;
    };
    // Putting our scheduler in the context makes every fiber started from it
    // (systems, handlers, and anything they fork) use the tick dispatcher.
    const context = Context.merge(provided, built).pipe(
      Context.add(Scheduler.Scheduler, scheduler),
      Context.add(Metric.FiberRuntimeMetrics, fiberCount)
    ) as Context.Context<unknown>;
    const runFork = Effect.runForkWith(context);

    // A tick's span is opened by hand, before its actions are applied each in
    // a fiber of its own, so that their spans and the systems' are its own.
    let tickSpan: Tracer.Span | undefined;
    const openSpan = (
      name: string,
      attributes: Record<string, unknown>
    ): Tracer.Span => {
      const made = runFork(
        Effect.makeSpan(name, {
          root: true,
          attributes,
          level: System.spanLevel,
        })
      ).pollUnsafe();
      if (made === undefined || Exit.isFailure(made)) {
        throw new Error(`The span "${name}" could not be made.`);
      }
      return made.value;
    };
    const endSpan = (
      span: Tracer.Span,
      exit: Exit.Exit<unknown, unknown>
    ): void => {
      span.end(
        Context.get(context, References.TracerTimingEnabled)
          ? Context.get(context, Clock.Clock).currentTimeNanosUnsafe()
          : 0n,
        exit
      );
    };

    System.unique(allSystems);
    // A hook runs when its state is entered or left, not with the rest.
    const ordered = System.order(
      allSystems.filter(
        (system) =>
          system.trigger === undefined &&
          !System.isFrameStage(system.stage) &&
          system.stage !== "input"
      )
    );
    // A frame's three stages, one after the other, are one list.
    const frameSystems = System.order(
      allSystems.filter(
        (system) =>
          system.trigger === undefined && System.isFrameStage(system.stage)
      )
    );
    const inputSystems = System.order(
      allSystems.filter(
        (system) => system.trigger === undefined && system.stage === "input"
      )
    );
    // What runs between ticks hears the events of every tick, the first
    // among them: they are kept for it from the start.
    if (frameSystems.length > 0) {
      events.expect("frame", time.tick);
    }
    if (inputSystems.length > 0) {
      events.expect("input", time.tick);
    }
    const hookKey = (trigger: System.Trigger): string =>
      `${trigger.state.name}\n${trigger.on}\n${trigger.value}`;
    // Chosen once, so an app that doesn't trace runs what it would without.
    // The default tracer makes spans and sends them nowhere: Effect compares
    // with it to tell that no tracer is installed. A span the minimum level
    // leaves out would be made and not sent, so none is made.
    const trace =
      Context.get(context, Tracer.Tracer) !== Tracer.nativeTracer &&
      Context.get(context, References.TracerEnabled) &&
      !LogLevel.isGreaterThan(
        Context.get(context, Tracer.MinimumTraceLevel),
        System.spanLevel
      );
    const tickTurns = ordered.map((system) => new Turn(system, trace));
    const frameTurns = frameSystems.map((system) => new Turn(system, trace));
    const inputTurns = inputSystems.map((system) => new Turn(system, trace));
    const hookGroups = new Map<string, Plugin.AnySystem[]>();
    const states = State.registryOf(world);
    // A state the save holds goes on from where it was, transitions included,
    // whether or not anything has looked at it yet.
    if (save !== undefined) {
      for (const state of State.defined()) {
        if (world.component(state.name) === state.component) {
          State.handleOf(world, state);
        }
      }
    }
    for (const system of allSystems) {
      if (system.trigger === undefined) {
        continue;
      }
      const state = system.trigger.state as State.State<string>;
      if (System.isFrameStage(system.stage)) {
        throw new Error(
          `System "${system.name}" is a hook and is in the frame stage. A hook runs at the start of a tick, when the game enters or leaves a state; the frame stage runs between ticks. Draw what a state looks like from a frame system with System.runIf(State.is(...)).`
        );
      }
      if (system.stage === "input") {
        throw new Error(
          `System "${system.name}" is a hook and is in the input stage. A hook runs at the start of a tick, when the game enters or leaves a state; the input stage runs before the tick. Read the devices only in some states with System.runIf(State.is(...)).`
        );
      }
      if (!state.values.includes(system.trigger.value)) {
        throw new Error(
          `System "${system.name}" is a hook for "${system.trigger.value}", which is not a value of the state "${state.name}". Its values are: ${state.values.join(", ")}.`
        );
      }
      State.handleOf(world, state);
      states.hooked.add(state);
      const key = hookKey(system.trigger);
      hookGroups.set(key, [...(hookGroups.get(key) ?? []), system]);
    }
    const hooks = new Map<string, Turn[]>();
    for (const [key, group] of hookGroups) {
      // `after` and `before` order the hooks of one moment among themselves.
      hooks.set(
        key,
        System.order(group).map((system) => new Turn(system, trace))
      );
    }

    /**
     * Runs one system of the tick as itself, with its own positions in
     * events and changes, and applies its commands.
     */
    const takeTurn = Effect.fnUntraced(function* (turn: Turn) {
      running = turn.system.name;
      events.reader = running;
      world.reader = running;
      const began = performance.now();
      turn.ran = true;
      if (turn.condition !== undefined && !(yield* turn.condition)) {
        turn.ran = false;
        if (turn.idle !== undefined) {
          yield* turn.idle;
        }
        // It sees nothing that changed while it was off, as no event.
        world.skip(running);
      } else {
        yield* turn.run;
      }
      commands.apply();
      turn.ms = performance.now() - began;
    });
    /** Makes one state transition: the exit hooks, the transition, then the enter hooks. */
    const makeMove = Effect.fnUntraced(function* (
      state: State.State<string>,
      move: State.Move
    ) {
      if (move.from !== undefined) {
        for (const hook of hooks.get(
          hookKey({ state, on: "exit", value: move.from })
        ) ?? []) {
          yield* takeTurn(hook);
        }
      }
      State.enter(world, state, move);
      for (const hook of hooks.get(
        hookKey({ state, on: "enter", value: move.to })
      ) ?? []) {
        yield* takeTurn(hook);
      }
    });
    /** Enters the requested states, and runs their hooks. */
    const enterStates = Effect.gen(function* () {
      for (const state of states.states) {
        // One move a tick, but for a game's first: entering the state it
        // starts in is followed by the move that was asked for before it.
        const move = State.pending(world, state);
        if (move === undefined) {
          continue;
        }
        yield* makeMove(state, move);
        if (move.followedBy !== undefined) {
          const asked = State.pending(world, state);
          // Unless a hook has asked for something else since.
          if (asked !== undefined && asked.to === move.followedBy) {
            yield* makeMove(state, asked);
          }
        }
      }
    });
    const tickEffect = Effect.gen(function* () {
      if (states.states.length > 0) {
        yield* enterStates;
      }
      observer?.(undefined);
      // Written out rather than calling `takeTurn`, which costs a generator
      // per system per tick. One reading of the clock ends a turn and
      // begins the next, which halves what timing them costs.
      let clock = performance.now();
      for (const turn of tickTurns) {
        running = turn.system.name;
        // Each system reads events, and what changed, from its own position.
        events.reader = running;
        world.reader = running;
        turn.ran = true;
        // A system with no condition is asked nothing.
        if (turn.condition !== undefined && !(yield* turn.condition)) {
          turn.ran = false;
          // What it does in place of running, if it was given anything.
          if (turn.idle !== undefined) {
            yield* turn.idle;
            commands.apply();
          }
          // It sees nothing that changed while it was off, as no event.
          world.skip(running);
        } else {
          yield* turn.run;
          commands.apply();
        }
        const now = performance.now();
        turn.ms = now - clock;
        clock = now;
        if (observer !== undefined) {
          observer(turn.system.name);
          // What it does is not the next system's to pay for.
          clock = performance.now();
        }
      }
    });

    // --- the stages between ticks: frame and input -------------------------------
    // Their systems get the world to read and nothing to change it with.
    // What is random there comes from a generator of its own, which is not
    // part of the world; and an action issued there is input from outside,
    // and is logged as such.
    const verifyFrames = options.verifyFrames === true;
    const frameRandom = new Rng(options.seed ?? 0);
    const frameContext = context.pipe(
      Context.add(Frame, frame),
      Context.add(Random, frameRandom),
      Context.add(EffectRandom.Random, {
        nextDoubleUnsafe: () =>
          ((frameRandom.bits() >>> 5) * 67_108_864 +
            (frameRandom.bits() >>> 6)) /
          9_007_199_254_740_992,
        nextIntUnsafe: () => {
          const magnitude =
            (frameRandom.bits() >>> 11) * 4_294_967_296 + frameRandom.bits();
          return (frameRandom.bits() & 1) === 0 ? magnitude : -magnitude;
        },
      }),
      Context.add(Action.Actions, {
        enqueue: (action, payload) => issue(action, payload),
        handles,
      }),
      Context.add(Ticks, {
        more() {
          throw new Error(
            "Ticks.more was called in the frame stage or the input stage. Whether the game ticks again is the game's to say, from a system of the tick: what draws it, or reads the devices, runs between ticks and decides nothing of it. A key that should wake the game issues an action."
          );
        },
      })
    ) as Context.Context<unknown>;
    const runFrameFork = Effect.runForkWith(frameContext);
    // The input stage is told what the devices say: one picture of them,
    // taken when the stage begins. It is not told about the frame.
    const source = Context.get(context, Input.Source);
    const devices: {
      -readonly [K in keyof Input.Sample]: Input.Sample[K];
    } = {
      down: new Set(),
      pressed: [],
      released: [],
      axes: new Map(),
      moved: [],
    };
    const noFrame = (): never => {
      throw new Error(
        "Frame was read by a system of the input stage. It tells the frame stage how far a frame is between two ticks; the input stage runs before a tick, and no frame is being drawn."
      );
    };
    const inputContext = frameContext.pipe(
      Context.add(Input.Devices, devices),
      Context.add(Frame, {
        get alpha() {
          return noFrame();
        },
        get delta() {
          return noFrame();
        },
        get count() {
          return noFrame();
        },
      })
    ) as Context.Context<unknown>;
    const runInputFork = Effect.runForkWith(inputContext);
    let frameHash = 0;
    const stageEffect = (
      stage: "frame" | "input",
      turns: readonly Turn[]
    ): Effect.Effect<void, unknown, unknown> =>
      Effect.gen(function* () {
        let clock = performance.now();
        for (const turn of turns) {
          running = turn.system.name;
          // A place of its own in events and in what changed, apart from
          // the simulation's and never saved.
          events.reader = `${FRAME_READER}${running}`;
          world.reader = events.reader;
          turn.ran = true;
          if (turn.condition !== undefined && !(yield* turn.condition)) {
            turn.ran = false;
            if (turn.idle !== undefined) {
              yield* turn.idle;
            }
            world.skip(world.reader);
          } else {
            yield* turn.run;
          }
          const now = performance.now();
          turn.ms = now - clock;
          clock = now;
          if (verifyFrames) {
            if (world._frameHash() !== frameHash) {
              return yield* Effect.die(
                new FrameChangedWorld({
                  stage,
                  system: running,
                  frame: frame.count,
                })
              );
            }
            // The hash is not the next system's to pay for.
            clock = performance.now();
          }
        }
      });
    const drawn = stageEffect("frame", frameTurns);
    const heardEffect = stageEffect("input", inputTurns);
    const frameEffect = trace
      ? Effect.suspend(() =>
          Effect.withSpan(drawn, "arcadekit/frame", {
            root: true,
            attributes: { "arcadekit.frame": frame.count },
            level: System.spanLevel,
          })
        )
      : drawn;
    const inputEffect = trace
      ? Effect.withSpan(heardEffect, "arcadekit/input", {
          root: true,
          level: System.spanLevel,
        })
      : heardEffect;

    yield* Effect.addFinalizer(() => Effect.sync(() => dispatcher.flush()));

    let ticking = false;
    // How deep the app is in running the game's own code between ticks: a
    // plugin's setup.
    let ownCode = 0;
    const runOwn = <A>(run: () => A): A => {
      ownCode++;
      try {
        return run();
      } finally {
        ownCode--;
      }
    };
    // The stage that is running between two ticks, if one is.
    let between: "frame" | "input" | undefined;
    // Whether the game asked for its next tick: `Ticks.more`. An app that
    // has not ticked yet has not been asked, and is taken to want one.
    let wanted = true;
    // The action whose handler is running, if one is.
    let applying: string | undefined;
    // A handler a tick runs is part of the tick: the stage wins.
    const phase = (): Phase =>
      ticking
        ? "tick"
        : (between ?? (applying !== undefined ? "handler" : "idle"));
    /** Whether the app is between ticks with nothing running. */
    const betweenTicks = (): boolean => phase() === "idle";
    const busy = (): string => {
      const now = phase();
      return now === "input"
        ? "run of the input stage"
        : now === "handler"
          ? `handler of "${applying}"`
          : now;
    };

    /**
     * Rolls back everything a handler did since the command buffer's mark was
     * taken: the world's rollback takes back what it wrote, emitted, read and
     * enqueued.
     */
    const undo = (commandMark: number): void => {
      world.rollback();
      commands.rollback(commandMark);
    };

    /**
     * Whether the code running now is the simulation's: a tick, an action's
     * handler, or a plugin's setup. What it
     * issues isn't logged, since a replay runs it again and issues it again.
     * Anything else is input from outside.
     */
    const simulating = (): boolean =>
      ticking || applying !== undefined || ownCode > 0;
    /** Issues an action from anywhere: `app.enqueue` and `Actions.enqueue`. */
    const enqueueAnywhere = (
      action: Action.AnyActionDef,
      payload: unknown
    ): Exit.Exit<void, Action.InvalidPayload> => {
      if (simulating()) {
        enqueueFromInside(action, payload);
        return Exit.void;
      }
      return enqueue(action, payload);
    };
    /**
     * `Actions.enqueue`, whose payload the compiler has checked. Outside the
     * simulation, that is only the frame and input stages.
     */
    const issue = (action: Action.AnyActionDef, payload: unknown): void => {
      const exit = enqueueAnywhere(action, payload);
      if (Exit.isFailure(exit)) {
        throw new Error(
          `A system of the frame or input stage issued the action "${action.name}" with a payload its schema does not take: ${describe(Cause.squash(exit.cause))}. It runs on one machine, so no other peer could hear of it: issue a payload the schema takes.`
        );
      }
    };
    const enqueueByNameAnywhere = (
      name: string,
      payload: unknown,
      from?: string
    ): void => {
      if (!simulating()) {
        enqueueByName(name, payload, from);
        return;
      }
      if (from !== undefined) {
        throw new Error(
          `enqueueByName("${name}") was given who issued it, "${from}", by the simulation. What the simulation issues is its own doing, on every peer alike, and nobody issued it.`
        );
      }
      intake.queued.push({
        name,
        payload,
        codec: undefined,
        entry: undefined,
        from,
      });
    };

    /**
     * Validates a payload and runs its handler to completion. The handler runs
     * in a world transaction: a refusal rolls back its component writes, the
     * random numbers it drew, what it read of events and changes, and what it
     * queued, emitted and enqueued. With `dispatched`, an accepted action is
     * logged; an enqueued one was logged on arrival, if it came from outside.
     */
    const apply = (
      name: string,
      payload: unknown,
      encoded: boolean,
      dispatched: boolean,
      from: string | undefined
    ): Exit.Exit<unknown, unknown> => {
      const handler = handlers.get(name);
      if (handler === undefined) {
        return Exit.fail(new Action.UnknownAction({ action: name }));
      }
      start();

      // Work out both forms of the payload: the value for the handler and the
      // JSON form for the log. Converting between them is what validates it.
      let value = payload;
      let logged = payload;
      const { codec } = handler.action;
      const converted = encoded
        ? Schema.decodeUnknownExit(codec)(payload)
        : Schema.encodeUnknownExit(codec)(payload);
      if (Exit.isFailure(converted)) {
        const error = Cause.squash(converted.cause);
        return Exit.fail(
          new Action.InvalidPayload({
            action: name,
            message: error instanceof Error ? error.message : String(error),
          })
        );
      }
      if (encoded) {
        value = converted.value;
      } else {
        logged = converted.value;
      }

      if (phase() === "handler") {
        throw new Error(
          `dispatch("${name}") was called from the handler of "${applying}". A handler issues another action with Actions.enqueue, which applies it on the next tick.`
        );
      }
      const commandMark = commands.mark();
      world.begin();
      applying = name;
      events.reader = `action:${name}`;
      world.reader = events.reader;
      let fiber: Fiber.Fiber<unknown, unknown>;
      const fibersBefore = fibers;
      notingStarters = false;
      fiberStarters = undefined;
      try {
        // The payload is the action's: its schema decoded it, or the
        // compiler checked it in a typed dispatch.
        const handled = handler.handle(value as never, { from });
        fiber = runFork(
          trace
            ? Effect.withSpan(
                handled,
                `action:${name}`,
                tickSpan === undefined
                  ? { root: true, level: System.spanLevel }
                  : { parent: tickSpan, level: System.spanLevel }
              )
            : handled
        );
      } finally {
        events.reader = undefined;
        world.reader = undefined;
        applying = undefined;
      }
      const exit = fiber.pollUnsafe();
      if (exit === undefined) {
        fiber.interruptUnsafe();
        undo(commandMark);
        throw new Error(
          `The handler for "${name}" did not finish synchronously. Handlers must not wait.`
        );
      }
      const left = leftFibers(fibersBefore, `The handler for "${name}"`);
      if (left !== undefined) {
        undo(commandMark);
        throw left;
      }
      // A refusal, and a handler that died of a bug half-way, both leave the
      // game as it was.
      if (Exit.isFailure(exit)) {
        undo(commandMark);
      } else {
        world.commit();
        commands.apply();
        // A tick tells the stages between ticks what it emitted when it
        // ends; an action applied between two is of the tick to come.
        if (!ticking) {
          events.told(time.tick + 1);
        }
        if (dispatched) {
          actionLog.push({
            tick: time.tick,
            name,
            payload: logged,
            ...(from === undefined ? {} : { from }),
          });
        }
      }
      return exit;
    };

    const assertBetweenTicks = (name: string): void => {
      if (diverted !== undefined) {
        throw new Error(
          `dispatch("${name}") was called on an app that a session has taken over. It would apply the action on this machine alone, and the peers would no longer be playing the same game. Use enqueue: the session has every peer apply it on the same tick.`
        );
      }
      const now = phase();
      if (now === "tick") {
        throw new Error(
          `dispatch("${name}") was called during a tick. Use enqueue: it applies the action at the start of the next tick.`
        );
      }
      if (now === "frame" || now === "input") {
        throw new Error(
          `dispatch("${name}") was called during the ${now} stage, which must not change the game. Issue it with Actions.enqueue: it is applied at the start of the next tick.`
        );
      }
    };

    /** Runs one of the two between-ticks stages, with the world frozen. */
    const runBetween = (
      stage: "frame" | "input"
    ): Exit.Exit<void, TickError<S, P>> => {
      between = stage;
      events.stage = stage;
      world.freeze();
      let exit: Exit.Exit<void, TickError<S, P>>;
      let drew: unknown;
      try {
        if (verifyFrames) {
          frameHash = world._frameHash();
        }
        const fibersBefore = fibers;
        notingStarters = true;
        fiberStarters = undefined;
        running = "";
        const fiber =
          stage === "frame"
            ? runFrameFork(frameEffect)
            : runInputFork(inputEffect);
        events.reader = undefined;
        world.reader = undefined;
        const outcome = fiber.pollUnsafe();
        if (outcome === undefined) {
          fiber.interruptUnsafe();
          throw new Error(
            `System "${running}" did not finish within the ${stage === "frame" ? "frame" : "input stage"}. Systems must be synchronous.`
          );
        }
        const left = leftFibers(
          fibersBefore,
          stage === "frame" ? "The frame" : "The input stage"
        );
        if (left !== undefined) {
          throw left;
        }
        // Its systems have had their chance at every event there is.
        events.ended(stage, time.tick);
        exit = outcome as Exit.Exit<void, TickError<S, P>>;
      } finally {
        between = undefined;
        events.stage = undefined;
        // Thawing finds a draw from the world's generator, and undoes it.
        try {
          world.thaw();
        } catch (error) {
          drew = error;
        }
      }
      // A defect, unless the stage had failed for a reason of its own.
      return drew === undefined || Exit.isFailure(exit) ? exit : Exit.die(drew);
    };

    const frameExit = (
      alpha: number,
      delta = 0
    ): Exit.Exit<void, TickError<S, P>> => {
      if (!betweenTicks()) {
        throw new Error(
          `App.frame was called from inside a ${busy()}. The frame stage runs between ticks.`
        );
      }
      if (frameSystems.length === 0) {
        return Exit.void;
      }
      frame.alpha = alpha;
      frame.delta = delta;
      frame.count++;
      return runBetween("frame");
    };

    const inputExit = (): Exit.Exit<void, TickError<S, P>> => {
      if (!betweenTicks()) {
        throw new Error(
          `App.input was called from inside a ${busy()}. The input stage runs between ticks, before one.`
        );
      }
      if (inputSystems.length === 0) {
        return Exit.void;
      }
      // One picture of the devices for the whole stage.
      Object.assign(devices, source.sample());
      intake.heard = true;
      return runBetween("input");
    };

    const tickExit = (
      delta: number,
      options?: TickOptions
    ): Exit.Exit<void, TickError<S, P>> => {
      if (diverted !== undefined) {
        throw new Error(
          "App.tick was called on an app that a session has taken over. It would move this machine's game a tick ahead of the other peers'. The session steps the app: call the session's tick, or give the session to the driver."
        );
      }
      return runTick(delta, options);
    };
    /**
     * Captures the game. `unseen` is for a moment the stages between ticks
     * will not run after before it is rewound to: their place in what changed
     * is kept too.
     */
    const captured = (
      unseen: boolean
    ): Exit.Exit<Captured, Save.SaveRefused> => {
      const refused = (message: string): Exit.Exit<never, Save.SaveRefused> =>
        Exit.fail(new Save.SaveRefused({ message }));
      if (commands.size > 0) {
        return refused(
          `${commands.size} commands are queued and not applied. They are applied at the end of a tick: capture after one.`
        );
      }
      let held: WorldMoment;
      try {
        held = world._capture();
      } catch (error) {
        if (error instanceof SnapshotError) {
          return refused(error.message);
        }
        throw error;
      }
      const moment: Captured = {
        tick: time.tick,
        world: held,
        told: events.mark(),
        // What runs between ticks has everything still to draw, unless it
        // has drawn nothing since.
        changes: world.saveChanges(
          unseen ? () => true : (reader) => !reader.startsWith(FRAME_READER)
        ),
        logLength: actionLog.length,
        wanted,
      };
      moments.add(moment);
      return Exit.succeed(moment);
    };
    /**
     * Puts the game back to a moment of this app. With `again`, to run the
     * same ticks again, as a session does: the stages between ticks don't
     * hear twice what they heard of them.
     */
    const rewound = (was: Captured, again: boolean): void => {
      dispatcher.flush();
      // What is queued on the buffer was never part of the world.
      commands.rollback(0);
      world._rewind(was.world);
      events.rewound(was.told, again);
      world.restoreChanges(was.changes);
      actionLog.length = was.logLength;
      while ((deltas.at(-1)?.tick ?? -1) >= was.tick) {
        deltas.pop();
      }
      wanted = was.wanted;
      commands.apply();
    };
    const runTick = (
      delta: number,
      options?: TickOptions
    ): Exit.Exit<void, TickError<S, P>> => {
      if (!betweenTicks()) {
        throw new Error(`App.tick was called from inside a ${busy()}`);
      }
      // A tick hears the devices first. Whoever steps the app may have
      // seen to it, as a driver does; if not, it is seen to here.
      if (
        !intake.heard &&
        inputSystems.length > 0 &&
        options?.input !== false
      ) {
        const exit = inputExit();
        if (Exit.isFailure(exit)) {
          // The tick did not run, and the next one is to hear first too.
          intake.heard = false;
          return exit;
        }
      }
      intake.heard = false;
      // Each tick is asked afresh: one in which nobody asks is the last.
      wanted = false;
      start();
      if (!trace) {
        return ticked(delta);
      }
      tickSpan = openSpan("arcadekit/tick", {
        "arcadekit.tick": time.tick + 1,
      });
      let exit: Exit.Exit<void, TickError<S, P>> | undefined;
      try {
        exit = ticked(delta);
        return exit;
      } catch (error) {
        exit = Exit.die(error);
        throw error;
      } finally {
        endSpan(tickSpan, exit ?? Exit.void);
        tickSpan = undefined;
      }
    };
    /** Runs one tick, once the input stage has been seen to. */
    const ticked = (delta: number): Exit.Exit<void, TickError<S, P>> => {
      ticking = true;
      try {
        // Queued actions are applied before time advances, so they land at the
        // same point in the timeline as an action dispatched between ticks.
        if (intake.queued.length > 0) {
          for (const action of intake.take()) {
            const { codec, entry, from, name, payload } = action;
            const exit = apply(name, payload, codec === undefined, false, from);
            if (Exit.isFailure(exit)) {
              const error = Cause.squash(exit.cause);
              if (entry !== undefined) {
                entry.refused = describe(error);
              }
              events.emit(Action.Rejected, {
                action: name,
                payload: jsonOf(action),
                error: refusal(error),
                from,
              });
            }
          }
        }

        if (deltas.at(-1)?.delta !== delta) {
          deltas.push({ tick: time.tick, delta });
        }
        time.delta = delta;
        time.elapsed += delta;
        time.tick++;

        events.open();
        const fibersBefore = fibers;
        notingStarters = true;
        fiberStarters = undefined;
        running = "";
        const fiber = runFork(
          tickSpan === undefined
            ? tickEffect
            : Effect.withParentSpan(tickEffect, tickSpan)
        );
        events.reader = undefined;
        world.reader = undefined;
        const exit = fiber.pollUnsafe();
        if (exit === undefined) {
          fiber.interruptUnsafe();
          dispatcher.flush();
          throw new Error(
            `System "${running}" did not finish within the tick. Systems must be synchronous: ` +
              `what takes longer than a tick keeps its place in the world, in a component or a state that a system moves on each tick.`
          );
        }

        const left = leftFibers(fibersBefore, `Tick ${time.tick}`);
        if (left !== undefined) {
          throw left;
        }
        commands.apply();
        events.close(time.tick);
        if (checkpointEvery > 0 && time.tick % checkpointEvery === 0) {
          checkpoint();
        }
        return exit as Exit.Exit<void, TickError<S, P>>;
      } finally {
        ticking = false;
      }
    };

    const app: App<TickError<S, P>, AllHandlers<H, P>> = {
      world,
      commands,
      events,
      time,
      dispatcher,
      plugins: plugins.map((plugin) => plugin.name),
      systemOrder: ordered.map((s) => s.name),
      get phase() {
        return phase();
      },
      frameOrder: frameSystems.map((s) => s.name),
      inputOrder: inputSystems.map((s) => s.name),
      actionLog,
      record(since) {
        if (!betweenTicks()) {
          throw new Error(
            `record() was called during a ${busy()}. A game is recorded between ticks.`
          );
        }
        const start = since === undefined ? began : tickOf(since);
        const from = since?.logLength ?? 0;
        if (
          start < began ||
          start > time.tick ||
          from > actionLog.length ||
          (actionLog[from - 1]?.tick ?? start) > start ||
          (actionLog[from]?.tick ?? start) < start
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
          log: actionLog.slice(from).map((entry) => ({ ...entry })),
        };
      },
      save() {
        if (!betweenTicks()) {
          throw new Error(
            `save() was called during a ${busy()}. A game is saved between ticks.`
          );
        }
        const refused = (message: string): Exit.Exit<never, Save.SaveRefused> =>
          Exit.fail(new Save.SaveRefused({ message }));
        if (commands.size > 0) {
          return refused(
            `${commands.size} commands are queued and not applied. They are applied at the end of a tick: save after one.`
          );
        }
        let bytes: Uint8Array;
        try {
          bytes = world.snapshot();
        } catch (error) {
          if (error instanceof SnapshotError) {
            return refused(error.message);
          }
          throw error;
        }
        return Exit.succeed({
          version,
          world: bytes,
          // The frame stage's readers are not the game's: a loaded game
          // has everything still to draw.
          changes: world.saveChanges(
            (reader) => !reader.startsWith(FRAME_READER)
          ),
          logLength: actionLog.length,
        });
      },
      get settled() {
        if (
          wanted ||
          intake.queued.length > 0 ||
          dispatcher.pending > 0 ||
          !events.settled()
        ) {
          return false;
        }
        for (const state of states.states) {
          if (State.pending(world, state) !== undefined) {
            return false;
          }
        }
        return true;
      },
      capture() {
        if (!betweenTicks()) {
          throw new Error(
            `capture() was called during a ${busy()}. A game is captured between ticks.`
          );
        }
        return captured(false);
      },
      rewind(moment) {
        if (!betweenTicks()) {
          throw new Error(
            `rewind() was called during a ${busy()}. A game is put back between ticks.`
          );
        }
        if (!moments.has(moment)) {
          throw new Error(
            "rewind() was given a moment that this app did not capture. A moment is of one app, in one run of the program: to bring a game back from elsewhere, save it and load the save."
          );
        }
        rewound(moment as Captured, false);
      },
      inspect() {
        if (!betweenTicks()) {
          throw new Error(
            `inspect() was called from inside a ${busy()}. A game is inspected between ticks.`
          );
        }
        const turns = [
          ...tickTurns,
          ...[...hooks.values()].flat(),
          ...inputTurns,
          ...frameTurns,
        ];
        return {
          tick: time.tick,
          ...world.contents(),
          systems: turns.map(({ ms, ran, system }) => ({
            name: system.name,
            stage: system.stage,
            ran,
            ms,
          })),
          events: events.lastTick(),
        };
      },
      checkpoint() {
        if (!betweenTicks()) {
          throw new Error(
            `checkpoint() was called during a ${busy()}. A checkpoint is taken between ticks, where a replay can compare it.`
          );
        }
        return checkpoint();
      },
      tickExit,
      tick(delta, options) {
        const exit = tickExit(delta, options);
        if (Exit.isFailure(exit)) {
          throw Cause.squash(exit.cause);
        }
      },
      frameExit,
      frame(alpha, delta) {
        const exit = frameExit(alpha, delta);
        if (Exit.isFailure(exit)) {
          throw Cause.squash(exit.cause);
        }
      },
      inputExit,
      input() {
        const exit = inputExit();
        if (Exit.isFailure(exit)) {
          throw Cause.squash(exit.cause);
        }
      },
      dispatch(action, payload) {
        assertBetweenTicks(action.name);
        // A typed dispatch of an action nobody handles is a programming error.
        if (!handlers.has(action.name)) {
          throw new Error(`No handler for action "${action.name}"`);
        }
        // What the action's handler returns or fails with.
        return apply(action.name, payload, false, true, undefined) as Exit.Exit<
          never,
          never
        >;
      },
      enqueue: enqueueAnywhere,
      dispatchByName(name, payload, from) {
        assertBetweenTicks(name);
        return apply(name, payload, true, true, from);
      },
      enqueueByName: enqueueByNameAnywhere,
      divert(take) {
        if (diverted !== undefined) {
          throw new Error(
            "divert() was called on an app that has been taken over already. An app is in one session at a time."
          );
        }
        diverted = take;
        return {
          deliver,
          tickExit: (delta, observe) => {
            observer = observe;
            try {
              return runTick(delta, NO_INPUT);
            } finally {
              observer = undefined;
            }
          },
          capture: () => {
            if (!betweenTicks()) {
              throw new Error(
                `capture() was called during a ${busy()}. A game is captured between ticks.`
              );
            }
            return captured(true);
          },
          rewind: (moment) => {
            if (!betweenTicks()) {
              throw new Error(
                `rewind() was called during a ${busy()}. A game is put back between ticks.`
              );
            }
            if (!moments.has(moment)) {
              throw new Error(
                "rewind() was given a moment that this app did not capture. A moment is of one app, in one run of the program: to bring a game back from elsewhere, save it and load the save."
              );
            }
            rewound(moment as Captured, true);
          },
        };
      },
    };

    // Each plugin's setup runs once, in the same order, with everything in
    // place. Not when loading: the save holds what setup made.
    for (const plugin of plugins) {
      if (plugin.setup === undefined || save !== undefined) {
        continue;
      }
      events.reader = `setup:${plugin.name}`;
      world.reader = events.reader;
      const { setup } = plugin;
      const fibersBefore = fibers;
      const fiber = runOwn(() => runFork(setup));
      events.reader = undefined;
      world.reader = undefined;
      const exit = fiber.pollUnsafe();
      if (exit === undefined) {
        fiber.interruptUnsafe();
        return yield* Effect.die(
          new Error(
            `The setup of plugin "${plugin.name}" did not finish synchronously. Setup must not wait.`
          )
        );
      }
      const left = leftFibers(
        fibersBefore,
        `The setup of plugin "${plugin.name}"`
      );
      if (left !== undefined) {
        return yield* Effect.die(left);
      }
      if (Exit.isFailure(exit)) {
        return yield* exit as Exit.Exit<never, Plugin.ErrorOf<P[number]>>;
      }
      commands.apply();
    }
    commands.apply();
    // What the setups emitted is of the tick to come.
    events.told(time.tick + 1);
    return app;
  }) as Effect.Effect<
    App<TickError<S, P>, AllHandlers<H, P>>,
    Plugin.ErrorOf<P[number]> | Save.LoadRefused,
    Scope.Scope | External<S, H, P>
  >;

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
export const replay = (app: Any, recording: Recording): void => {
  const { deltas, end, log, start } = recording;
  if (app.time.tick !== start) {
    throw new Error(
      `App.replay was given a recording that begins at tick ${start}, and the app has run ${app.time.tick} ticks. Replay a recording of a whole game into a fresh app, and one recorded since a save into an app loaded from that save.`
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
        `App.replay was given a recording with no delta for tick ${tick}: a recording's first run of deltas begins where it does. Decode a recording with App.decodeRecording, which checks it.`
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
