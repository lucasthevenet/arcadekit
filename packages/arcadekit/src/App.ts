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
import { Cause, Context, Effect, Exit, Layer, Metric, Result } from "effect";
import type { Scope } from "effect";
import * as Scheduler from "effect/Scheduler";

import * as Action from "./Action";
import * as Driver from "./Driver";
import { CommandBuffer } from "./ecs/commands";
import { Component, Field } from "./ecs/component";
import type { Entity } from "./ecs/component";
import { SnapshotError, readSingleton } from "./ecs/snapshot";
import { World as EcsWorld } from "./ecs/world";
import { EventBus } from "./Event";
import * as Inbox from "./Inbox";
import * as Journal from "./Journal";
import * as Loop from "./Loop";
import * as Plugin from "./Plugin";
import * as Runner from "./Runner";
import * as Save from "./Save";
import * as Schedule from "./Schedule";
import type { BuiltIn, TimeState } from "./Services";
import * as Stage from "./Stage";
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
   * where every action is already recorded: `Journal.replay` ticks this way.
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
   * The game as it was played, to replay with `Journal.replay`: the action log,
   * the delta of every tick, and the ticks it begins and ends at. It begins
   * where this app began, or at `since`, a save this app made, so that loading
   * that save and replaying the recording returns to the present. Only between
   * ticks.
   */
  readonly record: (since?: Save.Save) => Journal.Recording;
  /**
   * Saves the game as it is, to load later with `App.load`: the world, which
   * holds the time, the actions queued for the next tick, the events waiting
   * to be read and what change queries haven't visited yet, and the length
   * of the log. Only between ticks.
   *
   * Fails with `SaveRefused`, which names what is in the way: a queued action
   * or a waiting event whose payload its schema doesn't take, a field holding a
   * value that can't be saved, or commands queued but not applied.
   */
  readonly save: () => Exit.Exit<Save.Save, Save.SaveRefused>;
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
   * by the name of the store that holds it: under `Action.INTAKE`, the actions
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
   * `frame` dies with `Stage.FrameChangedWorld`, naming the system, if they differ.
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
 * `Journal.replay`, which verifies it against the log's checkpoints as it goes.
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
    const commands = new CommandBuffer(world);
    const events = new EventBus(world);
    // Attached before the world loads a save, which may hold some of each.
    const intake = new Action.Intake();
    world._attach(intake);
    world._attach(
      new Save.Visits(world, (reader) => !reader.startsWith(Stage.READER))
    );
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
      // Before anything else can touch the world: a load fills an empty one.
      const loaded = Result.try(() => {
        world.load(save.world);
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
    const log = new Journal.Log(world, time, options.checkpointEvery ?? 60);
    world._attach(log);
    // What systems and handlers issue goes through the inbox, made below
    // once the app's services are built.
    const actions: Context.Service.Shape<typeof Action.Actions> = {
      enqueue: (action, payload) => {
        inbox.issue(action, payload);
      },
      handles: (action) => inbox.handles(action),
    };
    const builtIns = Stage.tick({
      world,
      time,
      commands,
      events,
      intake,
      actions,
    });
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
    const runner = new Runner.Runner(
      dispatcher,
      Context.get(Context.merge(provided, built), Metric.FiberRuntimeMetrics),
      () => {
        // Nobody is reading once the game's code has run.
        events.reader = undefined;
        world.reader = undefined;
      }
    );
    // Putting our scheduler in the context makes every fiber started from it
    // (systems, handlers, and anything they fork) use the tick dispatcher.
    const context = Context.merge(provided, built).pipe(
      Context.add(Scheduler.Scheduler, scheduler),
      Context.add(Metric.FiberRuntimeMetrics, runner.metrics)
    ) as Context.Context<unknown>;
    const runFork = Effect.runForkWith(context);

    const spans = new Loop.Spans(context);
    const inbox = new Inbox.Inbox({
      world,
      commands,
      events,
      intake,
      log,
      runner,
      time,
      handlers,
      run: (name, handled) => runFork(spans.action(name, handled)),
    });
    const schedule = Schedule.make(allSystems, spans.enabled);
    // What runs between ticks hears the events of every tick, the first
    // among them: they are kept for it from the start.
    if (schedule.frame.length > 0) {
      events.expect("frame", time.tick);
    }
    if (schedule.input.length > 0) {
      events.expect("input", time.tick);
    }
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
    for (const state of schedule.hooked) {
      State.handleOf(world, state);
      states.hooked.add(state);
    }

    const loop = Loop.make({
      world,
      commands,
      events,
      intake,
      log,
      inbox,
      runner,
      time,
      schedule,
      spans,
      context,
      actions,
      seed: options.seed ?? 0,
      verifyFrames: options.verifyFrames === true,
    });
    // What a run ends with is what the game's systems fail with: the loop
    // runs them as systems of any game, and their types are claimed back.
    type Ran = Exit.Exit<void, TickError<S, P>>;
    const frameExit = (alpha: number, delta?: number): Ran =>
      loop.frame(alpha, delta) as Ran;
    const inputExit = (): Ran => loop.input() as Ran;
    const tickExit = (delta: number, options?: TickOptions): Ran => {
      if (inbox.diverted !== undefined) {
        throw new Error(
          "App.tick was called on an app that a session has taken over. It would move this machine's game a tick ahead of the other peers'. The session steps the app: call the session's tick, or give the session to the driver."
        );
      }
      return loop.tick(delta, options) as Ran;
    };

    yield* Effect.addFinalizer(() => Effect.sync(() => dispatcher.flush()));

    const app: App<TickError<S, P>, AllHandlers<H, P>> = {
      world,
      commands,
      events,
      time,
      dispatcher,
      plugins: plugins.map((plugin) => plugin.name),
      systemOrder: schedule.tick.map((turn) => turn.system.name),
      get phase() {
        return runner.phase;
      },
      frameOrder: schedule.frame.map((turn) => turn.system.name),
      inputOrder: schedule.input.map((turn) => turn.system.name),
      actionLog: log.entries,
      record(since) {
        runner.whileIdle(
          (busy) =>
            `record() was called during a ${busy}. A game is recorded between ticks.`
        );
        return log.record(
          since === undefined
            ? undefined
            : { tick: tickOf(since), logLength: since.logLength }
        );
      },
      save() {
        runner.whileIdle(
          (busy) =>
            `save() was called during a ${busy}. A game is saved between ticks.`
        );
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
          logLength: log.entries.length,
        });
      },
      get settled() {
        if (
          intake.wanted ||
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
      inspect() {
        runner.whileIdle(
          (busy) =>
            `inspect() was called from inside a ${busy}. A game is inspected between ticks.`
        );
        return {
          tick: time.tick,
          ...world.contents(),
          systems: schedule.all.map(({ ms, ran, system }) => ({
            name: system.name,
            stage: system.stage,
            ran,
            ms,
          })),
          events: events.lastTick(),
        };
      },
      checkpoint() {
        runner.whileIdle(
          (busy) =>
            `checkpoint() was called during a ${busy}. A checkpoint is taken between ticks, where a replay can compare it.`
        );
        return log.checkpoint();
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
      dispatch: (action, payload) =>
        // What the action's handler returns or fails with.
        inbox.dispatch(action, payload) as Exit.Exit<never, never>,
      enqueue: (action, payload) => inbox.enqueue(action, payload),
      dispatchByName: (name, payload, from) =>
        inbox.dispatchByName(name, payload, from),
      enqueueByName: (name, payload, from) => {
        inbox.enqueueByName(name, payload, from);
      },
      divert(take) {
        if (inbox.diverted !== undefined) {
          throw new Error(
            "divert() was called on an app that has been taken over already. An app is in one session at a time."
          );
        }
        inbox.diverted = take;
        return {
          deliver: (name, payload, from) => {
            inbox.deliver(name, payload, from);
          },
          tickExit: (delta, observe) =>
            loop.tick(delta, NO_INPUT, observe) as Ran,
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
      const { name, setup } = plugin;
      const ran = Result.try(() =>
        runner.asOwn(() =>
          runner.finish(
            () => runFork(setup),
            `The setup of plugin "${name}"`,
            () =>
              `The setup of plugin "${name}" did not finish synchronously. Setup must not wait.`,
            false
          )
        )
      );
      if (Result.isFailure(ran)) {
        return yield* Effect.die(ran.failure);
      }
      if (Exit.isFailure(ran.success)) {
        return yield* ran.success as Exit.Exit<
          never,
          Plugin.ErrorOf<P[number]>
        >;
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
