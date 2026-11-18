/**
 * The app ties the pieces together: a world, the built-in services, plugins,
 * an ordered list of systems, action handlers, and a `tick`.
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
 *   3. inside ONE fiber: enter the states that were asked for, running the
 *      hooks for leaving and entering; then run every system in order,
 *      but for the ones whose condition does not hold, applying queued
 *      commands after each
 *   4. resume scripts that were waiting for this tick or for an event
 *   5. flush the scheduler, so every fiber that became runnable runs now
 *   6. apply commands queued by scripts, and drop events everyone has seen
 *
 * The world's hash is recorded in the action log before the first action or
 * tick, and at the end of every `checkpointEvery`th tick.
 *
 * Between ticks, `frame` runs the systems of the frame stage, which draw
 * the game: with the world frozen, so that they cannot change it, and told
 * how far the frame is between two ticks. And `input`, just before a tick,
 * runs the systems of the input stage, which are told what the devices say
 * and turn it into actions: the same way, with the world frozen.
 *
 * A script that fails is logged with its cause. An app made with
 * `onScriptFailure: "stop"` also stops: that tick and every later one fail
 * with `ScriptFailed`.
 */
import {
  Cause,
  Context,
  Data,
  Effect,
  Random as EffectRandom,
  Exit,
  Layer,
  Schema,
} from "effect";
import type { Fiber, Scope } from "effect";
import * as Scheduler from "effect/Scheduler";

import * as Action from "./Action";
import * as Driver from "./Driver";
import { isSingletonSpec } from "./ecs/component";
import type { Listed } from "./ecs/component";
import { Rng } from "./ecs/random";
import { SnapshotError } from "./ecs/snapshot";
import { CommandBuffer, World as EcsWorld } from "./ecs/world";
import type { Guard, SavedChanges } from "./ecs/world";
import { EventBus, FRAME_READER } from "./Event";
import type { EventGuard, EventsMoment } from "./Event";
import * as Input from "./Input";
import * as Plugin from "./Plugin";
import * as Save from "./Save";
import {
  Commands,
  Events,
  Frame,
  Random,
  Script,
  Ticks,
  Time,
  World,
} from "./Services";
import type { BuiltIn, FrameState, TimeState } from "./Services";
import * as State from "./State";
import * as System from "./System";
import { TickDispatcher, TickScheduler } from "./TickScheduler";

type Systems = readonly Plugin.AnySystem[];
type Handlers = readonly Plugin.AnyHandler[];
type Plugins = readonly Plugin.Any[];

// Distributive on purpose: an empty list must give `never`, not `unknown`.
type SystemError<T> = T extends System.System<infer E, any> ? E : never;
type SystemNeeds<T> = T extends System.System<any, infer R> ? R : never;
type HandlerNeeds<T> =
  T extends Action.Handler<any, any, any, any, infer R> ? R : never;

type TickError<S extends Systems, P extends Plugins> =
  | SystemError<S[number]>
  | Plugin.TickErrorOf<P[number]>;
type AllHandlers<H extends Handlers, P extends Plugins> =
  | H[number]
  | Plugin.HandlerOf<P[number]>;
type Provided<P extends Plugins> = Plugin.ProvidedOf<P[number]>;

/**
 * What has to come from outside: whatever systems, handlers and setups need
 * that neither a plugin nor the app provides, plus whatever plugin layers
 * need that their declared dependencies do not provide.
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
type HandlerFor<HU, N extends string> = Extract<
  HU,
  Action.Handler<N, any, any, any, any>
>;
type PayloadFor<HU, N extends string> =
  HandlerFor<HU, N> extends Action.Handler<any, infer P, any, any, any>
    ? P
    : never;
type ResultFor<HU, N extends string> =
  HandlerFor<HU, N> extends Action.Handler<any, any, infer A, any, any>
    ? A
    : never;
type FailureFor<HU, N extends string> =
  HandlerFor<HU, N> extends Action.Handler<any, any, any, infer E, any>
    ? E
    : never;

/**
 * The part of an app that does not depend on its systems or handlers. Every
 * app is one of these, so use it for code that works with any app.
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
  /** The names of the frame stage's systems, in the order they run. */
  readonly frameOrder: readonly string[];
  /** The names of the input stage's systems, in the order they run. */
  readonly inputOrder: readonly string[];
  /**
   * The pairs of the tick's systems whose order matters and is not said:
   * both touch the same component, singleton, state or event, one of them
   * to write it, and nothing but the order they were listed in decides
   * which runs first. `System.conflicts` says how it is worked out. Only
   * the systems that said what they read and write, with `System.access`,
   * can be in one. A game settles a conflict with `System.after` or
   * `System.before`, and a test holds the list to empty.
   */
  readonly conflicts: readonly System.Conflict[];
  /**
   * The names of the tick's systems, hooks among them, that have not said
   * what they read and write: `conflicts` knows nothing of them.
   */
  readonly undeclared: readonly string[];
  /**
   * Runs one tick. Throws if a system fails, or if the app has stopped.
   *
   * A tick hears the devices first: if the input stage has not run since
   * the tick before, it is run now, as a driver would have, so a game that
   * steps its app by hand need not remember `app.input()`. `{ input: false
   * }` is a tick that reads nothing, for what runs a game again from its
   * log, where every action is already written: `App.replay` ticks so.
   */
  readonly tick: (delta: number, options?: TickOptions) => void;
  /**
   * Whether the game is at rest: a tick now would find nothing waiting for
   * it. It is false while an action waits to be applied, a state waits to
   * be entered, a script waits for the next tick or sleeps, a fiber is due,
   * or an event waits that some system has not had its chance at. Looking
   * changes nothing.
   *
   * A driver told to tick only when needed asks this, so that a game that
   * moves when its player does stands still in between. A system that
   * does something every tick while a condition of its own holds is not
   * seen unless it says so, with `Ticks.more`, each tick it has more to
   * do; and an app that has not ticked yet, new or just loaded, is not
   * settled, so that every system gets a tick to say so in.
   */
  readonly settled: boolean;
  /**
   * Runs the frame stage once: the systems made with
   * `System.inStage("frame")`, which draw the game as it stands between
   * two ticks. `alpha` says how far between them the frame is, from 0 just
   * after a tick up to 1 just before the next, and `delta` how many real
   * seconds have passed since the frame before; both reach the systems as
   * the `Frame` service. A driver calls this after the ticks of each frame.
   *
   * The world is frozen while it runs, and whatever would change the game
   * throws. Throws if a system fails, or if the app has stopped. Only
   * between ticks.
   */
  readonly frame: (alpha: number, delta?: number) => void;
  /**
   * Runs the input stage once: the systems made with
   * `System.inStage("input")`, which turn what the devices say into
   * actions. The devices are read once, here, and the systems are given
   * that one picture of them as `Input.Devices`. What they issue with
   * `Actions.enqueue` is logged and applied at the start of the next tick.
   * A driver calls this just before each tick, and a tick that finds it
   * was not called since the tick before runs it itself. A replay does
   * neither: the actions are in its log.
   *
   * The world is frozen while it runs, as for `frame`. Throws if a system
   * fails, or if the app has stopped. Only between ticks.
   */
  readonly input: () => void;
  /**
   * As `dispatch`, for actions that arrive as data: network messages, saved
   * games, replays. The payload is expected in its JSON form and is validated
   * against the action's schema; an unknown name or a bad payload is a
   * failure, `Action.UnknownAction` or `Action.InvalidPayload`, never a
   * crash. `from` says who issued it, as for `enqueueByName`.
   */
  readonly dispatchByName: (
    name: string,
    payload: unknown,
    from?: string
  ) => Exit.Exit<unknown, unknown>;
  /**
   * As `enqueue`, for actions that arrive as data. Problems become
   * `Action.Rejected` events.
   *
   * `from` says who issued it, for whoever brings an action in on someone
   * else's behalf, a server for its clients: the handler is told, and the
   * log keeps it. It is not for an app in a session, where what a peer
   * issues is stamped with the peer's own name.
   */
  readonly enqueueByName: (
    name: string,
    payload: unknown,
    from?: string
  ) => void;
  /**
   * What came into the game from outside, in the order it came, with
   * checkpoints of the world's hash among it: every dispatched action that
   * was accepted, and every action enqueued through the app, whatever
   * became of it. What a system, a script or a handler issued with
   * `Actions.enqueue` is not here, because a replay's own simulation issues
   * it again. Enough to replay the game, and to check the replay.
   */
  readonly actionLog: readonly Action.LogEntry[];
  /**
   * The game as it stands, to load later with `App.load`: the world, the
   * time, the actions waiting for the next tick, the events waiting to be
   * read, what change queries had yet to visit, and how long the log was.
   * It holds no script. Only between ticks.
   *
   * Fails with `SaveRefused`, which says what is in the way: an action or an
   * event with no schema is waiting, a field holds a value it cannot save,
   * or commands are queued and not applied.
   */
  readonly save: () => Exit.Exit<Save.Save, Save.SaveRefused>;
  /**
   * The game as it stands, kept in memory to come back to with `rewind`:
   * the world, the time, the actions waiting for the next tick, the events
   * waiting to be read, with every reader's place in them, what change
   * queries had yet to visit, and how long the log was. Only between ticks.
   *
   * It is not a save. It holds the waiting actions and events as they are,
   * so none of them needs a schema, and it is of this app and this run of
   * the program alone. It is what predicting a tick and running it again
   * is made of: `Rollback` captures before a tick it is not sure of.
   *
   * Fails with `SaveRefused` when the world cannot be put into a snapshot:
   * a field holds a value it cannot save, or commands are queued and not
   * applied.
   */
  readonly capture: () => Exit.Exit<Moment, Save.SaveRefused>;
  /**
   * Puts the game back as it was when `moment` was captured, in place: the
   * same app, world and services, holding what they held then. The log is
   * cut back to the length it had. Only between ticks, and only with a
   * moment of this app.
   *
   * What a moment does not hold is as for a save. Every script the app
   * watches is interrupted, and each plugin's scripts start again from
   * their beginning, as after a load: a script keeps what it must not lose
   * in the world. What a service of the game's own holds is left as it is.
   * A field that is `transient` is undefined afterwards. And what runs
   * between ticks starts over: the frame stage's and the input stage's
   * change queries visit everything again.
   */
  readonly rewind: (moment: Moment) => void;
  /**
   * Records the world's hash in the action log now, and returns it. For the
   * points a game wants checked beyond the ones `checkpointEvery` gives it,
   * such as the moment it is saved. Only between ticks.
   */
  readonly checkpoint: () => number;
}

/**
 * @param E  what a tick can fail with
 * @param R  services available to scripts, beyond the built-in ones
 * @param HU a union of the app's action handlers
 */
const NO_INPUT: TickOptions = { input: false };

/**
 * A game at one moment, held in memory: what `app.capture()` gives and
 * `app.rewind()` takes. It says which tick it is of, and the rest is the
 * app's own.
 *
 * @category Models
 */
export interface Moment {
  /** How many ticks had run when it was captured. */
  readonly tick: number;
}

/**
 * How a tick is run.
 *
 * @category Options
 */
export interface TickOptions {
  /**
   * Whether the tick runs the input stage first when nothing has since the
   * tick before. True when left out. False for a tick that must read no
   * device and hear no UI: a replay's, or a simulation run again from a
   * log.
   */
  readonly input?: boolean;
}

/**
 * What `divert` gives whoever took an app over: the two things the app no
 * longer does for anyone else.
 *
 * @category Models
 */
export interface Diverted<E = never> {
  /**
   * Queues an action for the next tick and logs it, as `enqueueByName` did:
   * by its name, with its payload in JSON form, and with who issued it.
   */
  readonly deliver: (name: string, payload: unknown, from?: string) => void;
  /** Runs one tick, as `tickExit` did. It reads no device. */
  readonly tickExit: (delta: number) => Exit.Exit<void, E>;
}

/**
 * A running game: its world, its time, the actions waiting for the next
 * tick, and what runs a tick and a frame. Made with `App.make`, `App.load`
 * or, in a page, `App.run`.
 *
 * `E` is what a tick can fail with, `R` what its systems need, and `HU`
 * the actions its handlers take.
 *
 * @category Models
 */
export interface App<E = never, R = never, HU = never> extends Any {
  /**
   * Takes the app over, for what decides on which tick an action is applied
   * and when a tick runs: a session of several peers, each of which has to
   * apply the same actions on the same ticks.
   *
   * From then on an action enqueued from outside is not queued for the next
   * tick. It is handed to `take`, by its name and with its payload in JSON
   * form: one given to `enqueue` or `enqueueByName`, and one issued with
   * `Actions.enqueue` in the input stage or the frame stage, so a key that
   * is bound to an action and a button of the UI are taken too. What the
   * simulation issues itself is not: every peer's own issues it.
   *
   * What it returns is the one way left to queue an action and to run a
   * tick. `tick`, `tickExit`, `dispatch` and `dispatchByName` throw from
   * then on: each would move this machine's game and nobody else's. An app
   * is taken over once.
   */
  readonly divert: (
    take: (name: string, payload: unknown) => void
  ) => Diverted<E>;
  /**
   * Runs one tick and returns the outcome, with system failures as a typed
   * `Exit`. An app that has stopped on a failed script runs nothing and
   * returns a defect, `ScriptFailed`.
   */
  readonly tickExit: (
    delta: number,
    options?: TickOptions
  ) => Exit.Exit<void, E>;
  /** As `frame`, with the outcome returned and a system's failure typed. */
  readonly frameExit: (alpha: number, delta?: number) => Exit.Exit<void, E>;
  /** As `input`, with the outcome returned and a system's failure typed. */
  readonly inputExit: () => Exit.Exit<void, E>;
  /**
   * Starts a long-running fiber (a coroutine). It runs immediately up to its
   * first wait, and from then on only advances during ticks. If it fails, the
   * failure is logged with its cause; see `onScriptFailure`.
   */
  readonly spawnScript: <A, E2>(
    effect: Effect.Effect<A, E2, R | BuiltIn>
  ) => Fiber.Fiber<A, E2>;
  /**
   * Applies an action now and returns the outcome. A refusal comes back as a
   * typed failure and leaves the game unchanged. An accepted action is
   * logged, and a refused one is not.
   *
   * For code outside the simulation, and only between ticks: it throws
   * during a tick, during the frame stage or the input stage, and from a
   * handler. It throws on an app that a session has taken over, where it
   * would move this machine's game alone: use `enqueue`.
   */
  readonly dispatch: <N extends ActionNames<HU>>(
    action: Action.ActionDef<N, PayloadFor<HU, N>, any>,
    payload: PayloadFor<HU, N>
  ) => Exit.Exit<ResultFor<HU, N>, FailureFor<HU, N>>;
  /**
   * Queues an action for the start of the next tick, and logs it. Use this
   * for real-time input. A refusal becomes an `Action.Rejected` event, and
   * is marked on the action's entry of the log.
   *
   * For code outside the simulation. A system, a script or a handler issues
   * an action with `Actions.enqueue`, which does not log it: logged, it
   * would be applied twice on replay, once from the log and once by the
   * replay's own simulation. On an app that a session has taken over, the
   * action goes to every peer, and one with no schema throws.
   */
  readonly enqueue: <N extends ActionNames<HU>>(
    action: Action.ActionDef<N, PayloadFor<HU, N>, any>,
    payload: PayloadFor<HU, N>
  ) => void;
}

/**
 * What a system that said what it reads and writes is held to while it
 * runs: `System.access` is all of what it does, so whatever it left out is
 * refused where it is done.
 */
interface Hold {
  /** For a message: `System "Movement"`. */
  readonly who: string;
  /** What the world refuses of its components, singletons and commands. */
  readonly world: Guard;
  /** What the bus refuses of its events. */
  readonly events: EventGuard;
  readonly random: boolean;
  readonly actions: boolean;
  readonly scripts: boolean;
}

/** What a refusal ends with: how a system says more. */
const ADVICE =
  " A system that says what it reads and writes says all of it: add this to its System.access, or leave the system without one.";

/** An error in a few words, for a log entry or a message. */
const describe = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

/**
 * A script failed in an app that was told to stop on one. It is the defect
 * every tick of that app fails with from then on.
 *
 * @category Errors
 */
export class ScriptFailed extends Data.TaggedError("ScriptFailed")<{
  /** Why the script failed. */
  readonly cause: Cause.Cause<unknown>;
  /** How many ticks had run when it failed. */
  readonly tick: number;
}> {
  override get message(): string {
    return `A script failed at tick ${this.tick}, and the app was told to stop on one: ${Cause.pretty(this.cause)}`;
  }
}

/**
 * A system of the frame stage, or of the input stage, changed the world,
 * which it must not: found by an app made with `verifyFrames`. It is a
 * defect, not a failure to handle: those stages run between ticks, and a
 * game that depends on having been drawn, or on its devices having been
 * read, does not replay.
 *
 * @category Errors
 */
export class FrameChangedWorld extends Data.TaggedError("FrameChangedWorld")<{
  /** The stage the system belongs to. */
  readonly stage: "frame" | "input";
  /** The system after which the world was no longer what it had been. */
  readonly system: string;
  /** Which frame it was, counted from 1: for the input stage, the last one drawn. */
  readonly frame: number;
}> {
  override get message(): string {
    return `The ${this.stage} stage changed the world: its hash was not the same after system "${this.system}" ran${this.stage === "frame" ? ` in frame ${this.frame}` : ""} as before. ${this.stage === "frame" ? "The frame stage draws the game between two ticks" : "The input stage reads the devices before a tick"} and must leave the world as it found it. Look for a write through the raw columns of eachChunk, which nothing stops where it is made, or a draw from world.random, which is otherwise only found when the stage ends.`;
  }
}

/**
 * What an app is made of and how it runs, as `App.make` and `App.load` take
 * it: its plugins, its own systems, handlers and components, and its
 * version.
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
   * Components and singletons that belong to the app itself, not to a
   * plugin. A world knows them by name, so loading a save needs every one
   * the save names to be listed here or by a plugin.
   */
  readonly components?: readonly Listed[];
  /**
   * The version of the game: a whole number that is raised when the game
   * changes its components or what its saves hold, 0 when left out. A save
   * records it. `App.load` reads a save of this version as it is, brings an
   * older one up to it with `migrations`, and refuses a newer one.
   */
  readonly version?: number;
  /**
   * How a save of an older version becomes one of the next: one migration
   * per version, each from `from` to `from + 1`. Only `App.load` uses them.
   */
  readonly migrations?: readonly Save.Migration[];
  /** Systems and handlers that belong to the app itself, not to a plugin. */
  readonly systems?: readonly [...S];
  readonly handlers?: readonly [...H];
  /**
   * Where the app's random sequence starts: a whole number from 0 to
   * `Number.MAX_SAFE_INTEGER`, 0 when left out. Two apps with the same seed
   * draw the same numbers from `Random`; a replay needs the seed its game
   * was played with.
   */
  readonly seed?: number;
  /**
   * How often the world's hash is recorded in the action log: at the end of
   * every tick whose number divides by this, and once before the first
   * action or tick. A replay of the log compares its own world at each of
   * these, so a smaller number finds a divergence closer to where it
   * happened, for one hash of the world a time. The default is 60. A
   * turn-based game wants 1; 0 records none.
   */
  readonly checkpointEvery?: number;
  /**
   * What a script's failure does, beyond being logged with its cause through
   * Effect's logger. `"log"`, the default, lets the game go on without the
   * script. `"stop"` stops the app: the tick the script failed in, and every
   * tick after it, fails with `ScriptFailed`, which stops a driver. A script
   * that is interrupted has not failed.
   */
  readonly onScriptFailure?: "log" | "stop";
  /**
   * Checks that the frame stage leaves the world as it found it, and the
   * input stage too: the
   * world's hash is taken before the stage and after each of its systems,
   * and `frame` dies with `FrameChangedWorld`, which names the system, if
   * they differ. Most ways to change the world from there throw where they
   * are made, and a draw from `world.random` is found when the frame ends
   * whether this is on or not. This finds the one that is left, a write
   * through raw columns, and says which system made either. It costs a
   * hash of the world per frame system per frame, so it is for development
   * and tests.
   */
  readonly verifyFrames?: boolean;
}

/**
 * Starts a game afresh: every plugin's `setup` runs, then its scripts start.
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
  App<TickError<S, P>, Provided<P> | External<S, H, P>, AllHandlers<H, P>>,
  Plugin.ErrorOf<P[number]>,
  Scope.Scope | External<S, H, P>
> =>
  build(options, undefined) as Effect.Effect<
    App<TickError<S, P>, Provided<P> | External<S, H, P>, AllHandlers<H, P>>,
    Plugin.ErrorOf<P[number]>,
    Scope.Scope | External<S, H, P>
  >;

/**
 * Brings a game back from a save, where it was: its world, its time, the
 * actions that were waiting for the next tick and the events that were
 * waiting to be read. Give it the plugins and options the game was made
 * with.
 *
 * No plugin's `setup` runs: the save holds what setup spawned. Every
 * plugin's scripts start again from their beginning, since a save cannot
 * hold a script in mid-flight.
 *
 * The app's action log starts empty. What the game logged after the save
 * (`log.slice(save.logLength)`) is replayed with `App.replay`, which checks
 * it against the log's checkpoints as it goes.
 *
 * Fails with `LoadRefused` when the save's world cannot be loaded: it names
 * a component no plugin lists, or one whose fields have changed, or its
 * bytes are damaged. So it does when the save is of another version of the
 * game and `migrations` do not bring it up to this one: see `Save.migrate`.
 *
 * **Gotchas**
 *
 * - A script that was started by hand, with `app.spawnScript` or
 *   `Script.spawn`, is not started again: whoever loads the game starts it.
 * - What a service of the game's own held is not in the save, and a
 *   `transient` field is undefined afterwards.
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
  App<TickError<S, P>, Provided<P> | External<S, H, P>, AllHandlers<H, P>>,
  Plugin.ErrorOf<P[number]> | Save.LoadRefused,
  Scope.Scope | External<S, H, P>
> => build(options, save);

/**
 * How `App.run` drives the app it makes.
 *
 * @category Options
 */
export interface RunOptions<
  A,
  E2 = never,
  R2 = never,
  SV extends Save.Save | undefined = undefined,
> {
  /** How many ticks a second the game runs at, whatever the rate of frames. */
  readonly hz: number;
  /** The most ticks one frame runs after a stall. 5 when left out. */
  readonly maxStepsPerCall?: number;
  /**
   * `"whenNeeded"` for a game that moves when its player does: it is drawn
   * every frame and ticks only while something is waiting for a tick, as
   * `Driver.frames` describes. `"always"`, a game in real time, when left
   * out.
   */
  readonly ticks?: "always" | "whenNeeded";
  /**
   * A save to go on from, in place of a fresh start: the app is made with
   * `App.load`, and `run` can fail with `Save.LoadRefused`.
   */
  readonly save?: SV;
  /**
   * Runs once, when the app is made and before its first frame, with the
   * app: to wire what is outside the game to it (a button that dispatches,
   * a menu that saves), or to keep hold of it. What it acquires is let go
   * with the app, and what it needs and can fail with are `run`'s.
   */
  readonly ready?: (app: A) => Effect.Effect<void, E2, R2>;
}

/**
 * The entry point: makes the app and runs it until it is interrupted.
 *
 *   Browser.runMain(App.run({ plugins: [Game] }, { hz: 60 }), { target: canvas })
 *
 * It is `App.make` and `Driver.frames` in a scope of their own: the app is
 * made, `ready` runs if there is one, and the frame loop follows the
 * display, running the ticks that are due, at `hz`, and then the frame
 * stage, once per repaint. It never ends by itself.
 *
 * Interrupting it stops the loop and closes that scope, so nothing is left
 * running: no frame asked for, no script, and whatever the plugins' layers
 * and `ready` acquired let go. The platform's `runMain` interrupts it when
 * the page goes away, or the process is told to stop.
 *
 * What the game needs from outside is provided to it as to `App.make`,
 * and stays provided for as long as it runs, which is what a layer that
 * listens, such as `Browser.layer`, needs. It fails with what
 * `App.make` and `ready` can fail with, and dies with what a tick throws.
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
  drive: RunOptions<
    App<TickError<S, P>, Provided<P> | External<S, H, P>, AllHandlers<H, P>>,
    E2,
    R2,
    SV
  >
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
  App<TickError<S, P>, Provided<P> | External<S, H, P>, AllHandlers<H, P>>,
  Plugin.ErrorOf<P[number]> | Save.LoadRefused,
  Scope.Scope | External<S, H, P>
> =>
  Effect.gen(function* () {
    const world = new EcsWorld(
      options.seed === undefined ? undefined : { seed: options.seed }
    );
    const { random } = world;
    const commands = new CommandBuffer(world);
    const events = new EventBus();
    const time: TimeState = { delta: 0, elapsed: 0, tick: 0 };
    const dispatcher = new TickDispatcher();
    const scheduler = new TickScheduler(dispatcher);

    // Fibers waiting for the next tick, in the order they started waiting.
    const waiters = new Set<() => void>();
    const nextTick: Effect.Effect<void> = Effect.callback<void>((resume) => {
      const waiter = () => resume(Effect.void);
      waiters.add(waiter);
      return Effect.sync(() => {
        waiters.delete(waiter);
      });
    });
    const sleep = (seconds: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const until = time.elapsed + seconds;
        // The epsilon absorbs float error from summing deltas like 1/60.
        while (time.elapsed + 1e-9 < until) {
          yield* nextTick;
        }
      });

    // Scripts the app watches: started with `app.spawnScript` or `Script.spawn`.
    const scripts = new Set<Fiber.Fiber<any, any>>();
    const stopOnFailure = options.onScriptFailure === "stop";
    let stopped: ScriptFailed | undefined;
    // Reports are logged with the app's context once it is built, so they
    // reach the loggers the caller provided.
    let reportContext = Context.empty() as Context.Context<any>;
    const watch = <A, E>(fiber: Fiber.Fiber<A, E>): Fiber.Fiber<A, E> => {
      const ended = (exit: Exit.Exit<A, E>): void => {
        scripts.delete(fiber);
        // Interrupted is not failed: that is how a script is stopped.
        if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
          return;
        }
        Effect.runForkWith(reportContext)(
          Effect.logError(`A script failed at tick ${time.tick}`, exit.cause)
        );
        if (stopOnFailure) {
          stopped ??= new ScriptFailed({ cause: exit.cause, tick: time.tick });
        }
      };
      const exit = fiber.pollUnsafe();
      if (exit === undefined) {
        scripts.add(fiber);
        fiber.addObserver(ended);
      } else {
        ended(exit);
      }
      return fiber;
    };
    // The system that is running, when it said what it reads and writes:
    // see `hold`, below.
    let held: Hold | undefined;
    const spawn = <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<Fiber.Fiber<A, E>, never, R> =>
      Effect.suspend(() => {
        if (held !== undefined && !held.scripts) {
          throw new Error(
            `${held.who} started a script, and did not say it would: scripts: true.${ADVICE}`
          );
        }
        return Effect.map(Effect.forkDetach(effect), (fiber) => watch(fiber));
      });

    // Dependencies first, each plugin once, then the app's own systems.
    const plugins = Plugin.flatten(options.plugins ?? []);
    const components = [
      ...plugins.flatMap((plugin) => plugin.components),
      ...(options.components ?? []),
    ];
    for (const listed of components) {
      if (isSingletonSpec(listed)) {
        world.singleton(listed);
      } else {
        world.register(listed);
      }
    }
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
      try {
        world.load(save.world);
        world.restoreChanges(save.changes);
      } catch (error) {
        if (error instanceof SnapshotError) {
          return yield* Effect.fail(
            new Save.LoadRefused({
              problem: error.problem,
              message:
                error.problem === "unknown component"
                  ? `${error.message} List it in a plugin's \`components\`, or in the app's.`
                  : error.message,
            })
          );
        }
        throw error;
      }
      time.tick = save.tick;
      time.elapsed = save.elapsed;
      time.delta = save.delta;
      events.restore(save.events);
    }
    const allSystems = [
      ...plugins.flatMap((plugin) => plugin.systems),
      ...(options.systems ?? []),
    ];
    const allHandlers = [
      ...plugins.flatMap((plugin) => plugin.handlers),
      ...(options.handlers ?? []),
    ];

    const handlers = new Map<string, Action.Handler<any, any, any, any, any>>();
    for (const handler of allHandlers) {
      if (handlers.has(handler.action.name)) {
        throw new Error(`Two handlers for action "${handler.action.name}"`);
      }
      handlers.set(handler.action.name, handler);
    }
    // `encoded` says which form the payload is in: the JSON form that arrives
    // from outside, or the value a handler works with. `entry` is the log
    // entry of an action that was enqueued from outside the simulation; one
    // that a system, a script or a handler issued has none.
    const queued: {
      readonly name: string;
      readonly payload: unknown;
      readonly encoded: boolean;
      readonly entry: { refused?: string } | undefined;
      /** Who issued it, if it came with a name. */
      readonly from: string | undefined;
    }[] = [];
    if (save !== undefined) {
      // In the JSON form they were saved in, checked again when applied.
      for (const { from, name, payload } of save.queued) {
        queued.push({ name, payload, encoded: true, entry: undefined, from });
      }
    }
    const actionLog: Action.LogEntry[] = [];
    // The moments this app has captured: `rewind` takes no other.
    const moments = new WeakSet<Moment>();
    /** What a moment holds beside its tick. */
    interface Captured extends Moment {
      readonly elapsed: number;
      readonly delta: number;
      readonly world: Uint8Array;
      readonly changes: SavedChanges[];
      readonly events: EventsMoment;
      readonly queued: (typeof queued)[number][];
      readonly logLength: number;
      readonly started: boolean;
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
    let started = false;
    const start = (): void => {
      if (started) {
        return;
      }
      started = true;
      // A checkpoint the game took by hand before starting already is it.
      if (checkpointEvery > 0 && actionLog.length === 0) {
        checkpoint();
      }
    };
    /**
     * Logs an action that was enqueued from outside, as it arrives. What
     * becomes of it is decided when it is applied, and a replay enqueues it
     * again at the same point and lets its own simulation decide.
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
    const handles = (action: Action.ActionDef<string, any, any>): boolean =>
      handlers.has(action.name);
    // Who has taken over what comes from outside, if anyone has: `divert`.
    let diverted: ((name: string, payload: unknown) => void) | undefined;
    /** From outside the simulation: `app.enqueue`. */
    const enqueue = (
      action: Action.ActionDef<string, any, any>,
      payload: unknown
    ): void => {
      const handler = handlers.get(action.name);
      if (handler === undefined) {
        throw new Error(`No handler for action "${action.name}"`);
      }
      // The log holds the JSON form. A payload that has none will be refused
      // as invalid when its turn comes, and is not worth an entry.
      const { codec } = handler.action;
      if (diverted !== undefined && codec === undefined) {
        throw new Error(
          `The action "${action.name}" was defined with a type and no schema, so it cannot be sent to the other peers of this game. Give Action.define a schema.`
        );
      }
      const json =
        codec === undefined
          ? Exit.succeed(payload)
          : Schema.encodeUnknownExit(codec)(payload);
      if (diverted !== undefined && Exit.isSuccess(json)) {
        diverted(action.name, json.value);
        return;
      }
      queued.push({
        name: action.name,
        payload,
        encoded: false,
        entry: Exit.isSuccess(json)
          ? arrived(action.name, json.value, undefined)
          : undefined,
        from: undefined,
      });
    };
    /** Queues an action that arrived as data for the next tick, and logs it. */
    const deliver = (name: string, payload: unknown, from?: string): void => {
      queued.push({
        name,
        payload,
        encoded: true,
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
    /** An action issued by a system that said its access, and not this. */
    const refuseAction = (name: string): void => {
      if (held !== undefined && !held.actions) {
        throw new Error(
          `${held.who} issued the action "${name}", and did not say it issues actions: actions: true.${ADVICE}`
        );
      }
    };
    /**
     * From inside the simulation: the `Actions` service. Not logged, because
     * a replay's own systems, scripts and handlers issue it again.
     */
    const enqueueFromInside = (
      action: Action.ActionDef<string, any, any>,
      payload: unknown
    ): void => {
      if (!handlers.has(action.name)) {
        throw new Error(`No handler for action "${action.name}"`);
      }
      refuseAction(action.name);
      queued.push({
        name: action.name,
        payload,
        encoded: false,
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
      Context.add(Script, { nextTick, sleep, spawn }),
      Context.add(Ticks, {
        more() {
          wanted = true;
        },
      }),
      Context.add(Events, events),
      Context.add(Action.Actions, { enqueue: enqueueFromInside, handles }),
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
    let layer: Layer.Layer<any, any, any> = Layer.succeedContext(builtIns);
    for (const plugin of plugins) {
      if (plugin.layer !== undefined) {
        layer = Layer.provideMerge(
          plugin.layer as Layer.Layer<any, any, any>,
          layer
        );
      }
    }
    const built = (yield* Layer.build(layer)) as Context.Context<any>;
    // Everything the caller provided (their services, resource overrides, the
    // scope) is captured once here and handed to every system and script.
    const provided = yield* Effect.context<External<S, H, P>>();
    // Putting our scheduler in the context makes every fiber started from it
    // (systems, handlers, scripts, and anything they fork) use the tick dispatcher.
    const context = Context.merge(provided, built).pipe(
      Context.add(Scheduler.Scheduler, scheduler)
    ) as Context.Context<any>;
    const runFork = Effect.runForkWith(context);
    reportContext = context;

    // A hook runs when its state is entered or left, not with the rest.
    System.unique(allSystems);
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
    events.keepFor({
      frame: frameSystems.length > 0,
      input: inputSystems.length > 0,
    });
    const hookKey = (trigger: System.Trigger): string =>
      `${trigger.state.name}\n${trigger.on}\n${trigger.value}`;
    const hooks = new Map<string, Plugin.AnySystem[]>();
    const states = State.registryOf(world);
    for (const listed of components) {
      if (listed instanceof State.State) {
        State.handleOf(world, listed);
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
      const key = hookKey(system.trigger);
      hooks.set(key, [...(hooks.get(key) ?? []), system]);
    }
    for (const [key, group] of hooks) {
      // `after` and `before` order the hooks of one moment among themselves.
      hooks.set(key, System.order(group));
    }

    // --- what a system said it reads and writes -----------------------------------
    // A system that said it, with `System.access`, is held to it while it
    // runs: the world and the bus are told what it may touch, and refuse
    // the rest where it is done. One that has not said is held to nothing.
    const holds = new Map<string, Hold>();
    for (const system of allSystems) {
      const said = System.accessOf(system);
      if (said === undefined) {
        continue;
      }
      const who = `System "${system.name}"`;
      const reads: (true | undefined)[] = [];
      const writes: (true | undefined)[] = [];
      const writeDefs = [];
      for (const { def, touch } of said.components.values()) {
        reads[def.id] = true;
        if (touch === "writes") {
          writes[def.id] = true;
          writeDefs.push(def);
        }
      }
      const emits = new Set<string>();
      for (const [name, touch] of said.events) {
        if (touch === "writes") {
          emits.add(name);
        }
      }
      holds.set(system.name, {
        who,
        world: {
          who,
          advice: ADVICE,
          reads,
          writes,
          writeDefs,
          queries: new Set(said.queries),
        },
        events: {
          who,
          advice: ADVICE,
          reads: new Set(said.events.keys()),
          emits,
        },
        random: said.random,
        actions: said.actions,
        scripts: said.scripts,
      });
    }
    const randomWas = new Uint32Array(4);
    /** Holds whoever runs next to what it said, if it said. */
    const hold = (to: Hold | undefined): void => {
      held = to;
      world.guard = to?.world;
      events.guard = to?.events;
      if (to !== undefined && !to.random) {
        randomWas.set(world.random.state);
      }
    };
    /** The system has run. A draw it did not say it makes is found here. */
    const release = (): void => {
      const was = held;
      if (was === undefined) {
        return;
      }
      held = undefined;
      world.guard = undefined;
      events.guard = undefined;
      const { state } = world.random;
      if (
        !was.random &&
        (state[0] !== randomWas[0] ||
          state[1] !== randomWas[1] ||
          state[2] !== randomWas[2] ||
          state[3] !== randomWas[3])
      ) {
        throw new Error(
          `${was.who} drew from Random, and did not say it would: random: true.${ADVICE}`
        );
      }
    };
    const report = System.conflicts(allSystems);

    let running = "";
    /** Runs one system as itself: with its own place in events and changes. */
    const runSystem = (
      system: Plugin.AnySystem
    ): Effect.Effect<void, unknown, unknown> =>
      Effect.suspend(() => {
        running = system.name;
        events.reader = running;
        world.reader = running;
        hold(holds.get(running));
        return Effect.map(
          system.condition === undefined
            ? system.run
            : Effect.flatMap(system.condition, (holds) =>
                holds ? system.run : (system.idle ?? Effect.void)
              ),
          release
        );
      });
    /** Makes one move of a state: the hooks for leaving, the move, the hooks for entering. */
    const makeMove = Effect.fnUntraced(function* (
      state: State.State<string>,
      move: State.Move
    ) {
      if (move.from !== undefined) {
        for (const hook of hooks.get(
          hookKey({ state, on: "exit", value: move.from })
        ) ?? []) {
          yield* runSystem(hook);
          commands.apply();
        }
      }
      State.enter(world, state, move);
      for (const hook of hooks.get(
        hookKey({ state, on: "enter", value: move.to })
      ) ?? []) {
        yield* runSystem(hook);
        commands.apply();
      }
    });
    /** The states that were asked for are entered, and their hooks run. */
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
    // Beside `ordered`: what each is held to, so that a system that has
    // not said costs a tick one read of this.
    const orderedHolds = ordered.map((system) => holds.get(system.name));
    const tickEffect = Effect.gen(function* () {
      if (states.states.length > 0) {
        yield* enterStates;
      }
      for (let at = 0; at < ordered.length; at++) {
        const system = ordered[at]!;
        running = system.name;
        // Each system reads events, and what changed, from its own position.
        events.reader = running;
        world.reader = running;
        const to = orderedHolds[at];
        if (to !== undefined) {
          hold(to);
        }
        // A system with no condition is asked nothing.
        if (system.condition !== undefined && !(yield* system.condition)) {
          // What it does in place of running, if it was given anything.
          if (system.idle !== undefined) {
            yield* system.idle;
            release();
            commands.apply();
          } else {
            release();
          }
          continue;
        }
        yield* system.run;
        // Its commands are applied as nobody's: it said them when it
        // queued them.
        if (to !== undefined) {
          release();
        }
        commands.apply();
      }
    });

    // --- the stages between ticks: frame and input -------------------------------
    // Their systems get the world to read and nothing to change it with.
    // What is random there comes from a generator of its own, which is not
    // part of the world; an action issued there is input from outside, and
    // is logged as such; and a script, which would run in the tick, cannot
    // be started from there.
    const verifyFrames = options.verifyFrames === true;
    const frameRandom = new Rng(options.seed ?? 0);
    const notInFrame = (what: string) => (): never => {
      throw new Error(
        `${what} was used in the frame stage or the input stage. A script runs in the tick and is part of the simulation; those stages run between ticks and finish at once.`
      );
    };
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
        enqueue: ((action, payload) => {
          refuseAction(action.name);
          enqueue(action, payload);
        }) as typeof enqueue,
        handles,
      }),
      Context.add(Script, {
        nextTick: Effect.sync(notInFrame("Script.nextTick")),
        sleep: notInFrame("Script.sleep"),
        spawn: notInFrame("Script.spawn"),
      }),
      Context.add(Ticks, {
        more() {
          throw new Error(
            "Ticks.more was called in the frame stage or the input stage. Whether the game ticks again is the game's to say, from a system of the tick: what draws it, or reads the devices, runs between ticks and decides nothing of it. A key that should wake the game issues an action."
          );
        },
      })
    ) as Context.Context<any>;
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
    ) as Context.Context<any>;
    const runInputFork = Effect.runForkWith(inputContext);
    let frameHash = 0;
    const stageEffect = (
      stage: "frame" | "input",
      systems: readonly Plugin.AnySystem[]
    ): Effect.Effect<void, unknown, unknown> =>
      Effect.gen(function* () {
        for (const system of systems) {
          running = system.name;
          // A place of its own in events and in what changed, apart from
          // the simulation's and never saved.
          events.reader = `${FRAME_READER}${running}`;
          world.reader = events.reader;
          hold(holds.get(running));
          if (system.condition !== undefined && !(yield* system.condition)) {
            if (system.idle === undefined) {
              release();
              continue;
            }
            // What it does in place of running, held to the same.
            yield* system.idle;
          } else {
            yield* system.run;
          }
          release();
          if (verifyFrames && world.hash() !== frameHash) {
            return yield* Effect.die(
              new FrameChangedWorld({
                stage,
                system: running,
                frame: frame.count,
              })
            );
          }
        }
      });
    const frameEffect = stageEffect("frame", frameSystems);
    const inputEffect = stageEffect("input", inputSystems);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        // Copied first: interrupting a fiber removes it from the set.
        for (const fiber of Array.from(scripts)) {
          fiber.interruptUnsafe();
        }
        dispatcher.flush();
      })
    );

    let ticking = false;
    // The stage that is running between two ticks, if one is.
    let between: "frame" | "input" | undefined;
    // Whether the input stage has run since the last tick.
    let heard = false;
    // Whether the game asked for its next tick: `Ticks.more`. An app that
    // has not ticked yet has not been asked, and is taken to want one.
    let wanted = true;
    const busy = (): string =>
      ticking
        ? "tick"
        : between === "input"
          ? "run of the input stage"
          : "frame";

    // The action whose handler is running, if one is.
    let applying: string | undefined;

    /** Takes back everything a handler did since the three marks were taken. */
    const undo = (
      commandMark: number,
      eventMark: ReturnType<EventBus["mark"]>,
      queuedMark: number
    ): void => {
      world.rollback();
      commands.rollback(commandMark);
      events.rollback(eventMark);
      queued.length = queuedMark;
    };

    /**
     * Validates a payload and runs its handler to completion. The handler
     * runs in a transaction of the world: a refusal takes back what it wrote
     * to components, the random numbers it drew, what it read of events and
     * of changes, and what it queued, emitted
     * and enqueued. With `dispatched`, an accepted action is logged; an
     * enqueued one was logged, if it came from outside, when it arrived.
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
      if (codec !== undefined) {
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
      }

      if (applying !== undefined) {
        throw new Error(
          `dispatch("${name}") was called from the handler of "${applying}". A handler issues another action with Actions.enqueue, which applies it on the next tick.`
        );
      }
      const commandMark = commands.mark();
      const eventMark = events.mark();
      const queuedMark = queued.length;
      world.begin();
      applying = name;
      events.reader = `action:${name}`;
      world.reader = events.reader;
      let fiber: Fiber.Fiber<unknown, unknown>;
      try {
        fiber = runFork(handler.handle(value, { from }));
      } finally {
        events.reader = undefined;
        world.reader = undefined;
        applying = undefined;
      }
      const exit = fiber.pollUnsafe();
      if (exit === undefined) {
        fiber.interruptUnsafe();
        undo(commandMark, eventMark, queuedMark);
        throw new Error(
          `The handler for "${name}" did not finish synchronously. Handlers must not wait.`
        );
      }
      // A refusal, and a handler that died of a bug half-way, both leave the
      // game as it was.
      if (Exit.isFailure(exit)) {
        undo(commandMark, eventMark, queuedMark);
      } else {
        world.commit();
        events.commit();
        commands.apply();
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
      if (ticking) {
        throw new Error(
          `dispatch("${name}") was called during a tick. Use enqueue from systems and scripts.`
        );
      }
      if (between !== undefined) {
        throw new Error(
          `dispatch("${name}") was called during the ${between} stage, which must not change the game. Issue it with Actions.enqueue: it is applied at the start of the next tick.`
        );
      }
    };

    /** Runs one of the two stages between ticks, with the world frozen. */
    const runBetween = (
      stage: "frame" | "input"
    ): Exit.Exit<void, TickError<S, P>> => {
      between = stage;
      world.freeze();
      let exit: Exit.Exit<void, TickError<S, P>>;
      let drew: unknown;
      try {
        if (verifyFrames) {
          frameHash = world.hash();
        }
        const fiber =
          stage === "frame"
            ? runFrameFork(frameEffect)
            : runInputFork(inputEffect);
        events.reader = undefined;
        world.reader = undefined;
        // A system that failed was not released.
        held = undefined;
        world.guard = undefined;
        events.guard = undefined;
        const outcome = fiber.pollUnsafe();
        if (outcome === undefined) {
          fiber.interruptUnsafe();
          throw new Error(
            `System "${running}" did not finish within the ${stage === "frame" ? "frame" : "input stage"}. Systems must be synchronous.`
          );
        }
        // Events are kept until each stage has heard them.
        if (stage === "frame") {
          events.endFrame();
        } else {
          events.endInput();
        }
        exit = outcome as Exit.Exit<void, TickError<S, P>>;
      } finally {
        between = undefined;
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
      if (ticking || between !== undefined) {
        throw new Error(
          `App.frame was called from inside a ${busy()}. The frame stage runs between ticks.`
        );
      }
      if (stopped !== undefined) {
        return Exit.die(stopped);
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
      if (ticking || between !== undefined) {
        throw new Error(
          `App.input was called from inside a ${busy()}. The input stage runs between ticks, before one.`
        );
      }
      if (stopped !== undefined) {
        return Exit.die(stopped);
      }
      if (inputSystems.length === 0) {
        return Exit.void;
      }
      // One picture of the devices for the whole stage.
      Object.assign(devices, source.sample());
      heard = true;
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
    const runTick = (
      delta: number,
      options?: TickOptions
    ): Exit.Exit<void, TickError<S, P>> => {
      if (ticking || between !== undefined) {
        throw new Error(`App.tick was called from inside a ${busy()}`);
      }
      if (stopped !== undefined) {
        return Exit.die(stopped);
      }
      // A tick hears the devices first. Whoever steps the app may have
      // seen to it, as a driver does; if not, it is seen to here.
      if (!heard && inputSystems.length > 0 && options?.input !== false) {
        const exit = inputExit();
        if (Exit.isFailure(exit)) {
          // The tick did not run, and the next one is to hear first too.
          heard = false;
          return exit;
        }
      }
      heard = false;
      // Each tick is asked afresh: one in which nobody asks is the last.
      wanted = false;
      start();
      ticking = true;
      try {
        // Queued actions are applied before time advances, so they land at the
        // same point in the timeline as an action dispatched between ticks.
        if (queued.length > 0) {
          const batch = queued.splice(0);
          for (const { encoded, entry, from, name, payload } of batch) {
            const exit = apply(name, payload, encoded, false, from);
            if (Exit.isFailure(exit)) {
              const error = Cause.squash(exit.cause);
              if (entry !== undefined) {
                entry.refused = describe(error);
              }
              events.emit(Action.Rejected, {
                action: name,
                payload,
                error,
                from,
              });
            }
          }
        }

        time.delta = delta;
        time.elapsed += delta;
        time.tick++;

        events.beginTick();
        const fiber = runFork(tickEffect);
        events.reader = undefined;
        world.reader = undefined;
        // A system that failed was not released.
        held = undefined;
        world.guard = undefined;
        events.guard = undefined;
        const exit = fiber.pollUnsafe();
        if (exit === undefined) {
          fiber.interruptUnsafe();
          dispatcher.flush();
          throw new Error(
            `System "${running}" did not finish within the tick. Systems must be synchronous; ` +
              `start long-running work with Script.spawn.`
          );
        }

        if (waiters.size > 0) {
          // Copied first: a resumed script usually starts waiting again.
          const batch = Array.from(waiters);
          waiters.clear();
          for (const resume of batch) {
            resume();
          }
        }
        dispatcher.flush();
        // A script woken by an event may emit one that wakes another script.
        let rounds = 0;
        while (events.resumeWaiters()) {
          dispatcher.flush();
          if (++rounds > dispatcher.maxRounds) {
            throw new Error(
              "Scripts kept waking each other with events for too long in one tick"
            );
          }
        }
        commands.apply();
        events.endTick();
        if (checkpointEvery > 0 && time.tick % checkpointEvery === 0) {
          checkpoint();
        }
        // A script failed during this tick (or since the last one) and the
        // app stops on that. The tick itself ran to its end first.
        if (stopped !== undefined && Exit.isSuccess(exit)) {
          return Exit.die(stopped);
        }
        return exit as Exit.Exit<void, TickError<S, P>>;
      } finally {
        ticking = false;
      }
    };

    const app: App<
      TickError<S, P>,
      Provided<P> | External<S, H, P>,
      AllHandlers<H, P>
    > = {
      world,
      commands,
      events,
      time,
      dispatcher,
      plugins: plugins.map((plugin) => plugin.name),
      systemOrder: ordered.map((s) => s.name),
      frameOrder: frameSystems.map((s) => s.name),
      inputOrder: inputSystems.map((s) => s.name),
      conflicts: report.conflicts,
      undeclared: report.undeclared,
      actionLog,
      save() {
        if (ticking || between !== undefined) {
          throw new Error(
            "save() was called during a tick or a frame. A game is saved between ticks."
          );
        }
        const refused = (message: string): Exit.Exit<never, Save.SaveRefused> =>
          Exit.fail(new Save.SaveRefused({ message }));
        if (commands.size > 0) {
          return refused(
            `${commands.size} commands are queued and not applied. They are applied at the end of a tick: save after one.`
          );
        }
        const waiting: { name: string; payload: unknown; from?: string }[] = [];
        for (const { encoded, from, name, payload } of queued) {
          const issuer = from === undefined ? {} : { from };
          if (encoded) {
            waiting.push({ name, payload, ...issuer });
            continue;
          }
          const codec = handlers.get(name)?.action.codec;
          if (codec === undefined) {
            return refused(
              `The action "${name}" is waiting for the next tick, and it was defined with a type and no schema, so it cannot be saved. Give Action.define a schema, or save after the tick that applies it.`
            );
          }
          const json = Schema.encodeUnknownExit(codec)(payload);
          if (Exit.isFailure(json)) {
            return refused(
              `The action "${name}" is waiting for the next tick with a payload its schema does not take: ${describe(Cause.squash(json.cause))}`
            );
          }
          waiting.push({ name, payload: json.value, ...issuer });
        }
        const pending = events.save();
        if (Exit.isFailure(pending)) {
          return refused(describe(Cause.squash(pending.cause)));
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
          tick: time.tick,
          elapsed: time.elapsed,
          delta: time.delta,
          world: bytes,
          queued: waiting,
          events: pending.value,
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
          queued.length > 0 ||
          waiters.size > 0 ||
          dispatcher.pending > 0 ||
          events.waiting()
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
        if (ticking || between !== undefined) {
          throw new Error(
            `capture() was called during a ${busy()}. A game is captured between ticks.`
          );
        }
        const refused = (message: string): Exit.Exit<never, Save.SaveRefused> =>
          Exit.fail(new Save.SaveRefused({ message }));
        if (commands.size > 0) {
          return refused(
            `${commands.size} commands are queued and not applied. They are applied at the end of a tick: capture after one.`
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
        const moment: Captured = {
          tick: time.tick,
          elapsed: time.elapsed,
          delta: time.delta,
          world: bytes,
          // What runs between ticks has everything still to draw.
          changes: world.saveChanges(
            (reader) => !reader.startsWith(FRAME_READER)
          ),
          events: events.capture(),
          queued: queued.slice(),
          logLength: actionLog.length,
          started,
          wanted,
        };
        moments.add(moment);
        return Exit.succeed(moment);
      },
      rewind(moment) {
        if (ticking || between !== undefined) {
          throw new Error(
            `rewind() was called during a ${busy()}. A game is put back between ticks.`
          );
        }
        if (applying !== undefined) {
          throw new Error(
            `rewind() was called from the handler of "${applying}". A game is put back between ticks.`
          );
        }
        if (!moments.has(moment)) {
          throw new Error(
            "rewind() was given a moment that this app did not capture. A moment is of one app, in one run of the program: to bring a game back from elsewhere, save it and load the save."
          );
        }
        const was = moment as Captured;
        // The scripts first: none of them is part of what was captured.
        for (const fiber of Array.from(scripts)) {
          fiber.interruptUnsafe();
        }
        dispatcher.flush();
        waiters.clear();
        // What is queued on the buffer was never part of the world.
        commands.rollback(0);
        world.restore(was.world);
        world.restoreChanges(was.changes);
        time.tick = was.tick;
        time.elapsed = was.elapsed;
        time.delta = was.delta;
        events.rewind(was.events);
        queued.length = 0;
        for (const action of was.queued) {
          // It is waiting again: what became of it has not happened.
          if (action.entry !== undefined) {
            delete action.entry.refused;
          }
          queued.push(action);
        }
        actionLog.length = was.logLength;
        started = was.started;
        wanted = was.wanted;
        heard = false;
        stopped = undefined;
        // As after a load: each plugin's scripts, from their beginning.
        for (const plugin of plugins) {
          for (const script of plugin.scripts) {
            watch(runFork(script as Effect.Effect<unknown, unknown, any>));
          }
        }
        commands.apply();
      },
      checkpoint() {
        if (ticking) {
          throw new Error(
            "checkpoint() was called during a tick. A checkpoint is taken between ticks, where a replay can compare it."
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
      spawnScript(effect) {
        return watch(runFork(effect as Effect.Effect<any, any, any>));
      },
      dispatch(action, payload) {
        assertBetweenTicks(action.name);
        // A typed dispatch of an action nobody handles is a programming error.
        if (!handlers.has(action.name)) {
          throw new Error(`No handler for action "${action.name}"`);
        }
        return apply(action.name, payload, false, true, undefined) as Exit.Exit<
          any,
          any
        >;
      },
      enqueue,
      dispatchByName(name, payload, from) {
        assertBetweenTicks(name);
        return apply(name, payload, true, true, from);
      },
      enqueueByName,
      divert(take) {
        if (diverted !== undefined) {
          throw new Error(
            "divert() was called on an app that has been taken over already. An app is in one session at a time."
          );
        }
        diverted = take;
        return { deliver, tickExit: (delta) => runTick(delta, NO_INPUT) };
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
      const fiber = runFork(plugin.setup);
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
      if (Exit.isFailure(exit)) {
        return yield* exit as Exit.Exit<never, Plugin.ErrorOf<P[number]>>;
      }
      commands.apply();
    }
    // Then every plugin's scripts, on a fresh start and after a load alike:
    // a script runs up to its first wait, and from then on during ticks.
    for (const plugin of plugins) {
      for (const script of plugin.scripts) {
        watch(runFork(script as Effect.Effect<unknown, unknown, any>));
      }
    }
    commands.apply();
    return app;
  }) as Effect.Effect<
    App<TickError<S, P>, Provided<P> | External<S, H, P>, AllHandlers<H, P>>,
    Plugin.ErrorOf<P[number]> | Save.LoadRefused,
    Scope.Scope | External<S, H, P>
  >;

/**
 * A world's hash is not the one recorded for the same point of the game.
 * The two have been different worlds since some tick after `agreedAt`.
 *
 * @category Errors
 */
export class HashMismatch extends Data.TaggedError("HashMismatch")<{
  /** The tick both hashes were taken at. */
  readonly tick: number;
  /** The hash that was recorded. */
  readonly expected: number;
  /** The hash of the world that was compared with it. */
  readonly actual: number;
  /** The tick of the last checkpoint that did match, if one did. */
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
 * A replayed log did not behave as it did when it was recorded.
 *
 * @category Errors
 */
export class ReplayDiverged extends Data.TaggedError("ReplayDiverged")<{
  /** Position in the log of the entry that did not hold. */
  readonly index: number;
  readonly entry: Action.LogEntry;
  /**
   * Why: the error an action was refused with, or a `HashMismatch` for a
   * checkpoint.
   */
  readonly reason: unknown;
}> {
  /** The tick of the entry that did not hold. */
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
 * Re-applies a recorded action log to a fresh app, ticking with a fixed
 * delta. With the same systems, the same seed and the same starting state,
 * the result is the same game.
 *
 * The replay checks itself against the log, and throws `ReplayDiverged` at
 * the first entry that does not hold:
 *
 * - A checkpoint whose hash is not the hash of the replay's world. The
 *   replay stops at that tick, before applying anything recorded after it.
 *   With a checkpoint every tick, that is the tick it diverged on.
 * - A dispatched action that is refused. The log only holds dispatched
 *   actions that were accepted, so the log was altered or the game has
 *   changed since.
 * - An enqueued action that is refused where the game accepted it, or the
 *   other way round. It is enqueued again at the point it arrived, and the
 *   replay stops after the tick that applied it.
 *
 * Actions that the game's systems, scripts and handlers issued are not in
 * the log: the replay's own issue them again.
 *
 * **Gotchas**
 *
 * - The log does not say the delta or the number of ticks it was recorded
 *   at, nor when a script was started by hand with `app.spawnScript`:
 *   whoever replays supplies them.
 * - It runs neither the frame stage nor the input stage: each tick is run
 *   with `{ input: false }`.
 * - A log with no checkpoints, from an app made with `checkpointEvery: 0`,
 *   is checked by its actions alone: a replay that has gone another way
 *   runs on until an action happens to be refused, or to its end.
 *
 * @category Running
 */
export const replay = (
  app: Any,
  log: readonly Action.LogEntry[],
  options: { readonly delta: number; readonly ticks: number }
): void => {
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
  for (let i = 0; i < options.ticks; i++) {
    applyDue();
    // A replay reads no device: what the devices said is in the log.
    app.tick(options.delta, NO_INPUT);
    checkQueued();
  }
  applyDue();
  const unreached = log[next];
  if (unreached !== undefined) {
    throw new ReplayDiverged({
      index: next,
      entry: unreached,
      reason: `its tick (${unreached.tick}) was never reached; the log is out of order or longer than ${options.ticks} ticks`,
    });
  }
};
