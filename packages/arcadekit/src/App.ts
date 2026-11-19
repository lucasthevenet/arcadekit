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
 *   4. resume scripts that were waiting for this tick or for an event
 *   5. flush the scheduler, so every fiber that became runnable runs now
 *   6. apply commands queued by scripts, and drop events everyone has seen
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
 * A failed script is logged with its cause. An app created with
 * `onScriptFailure: "stop"` also stops: that tick and every later one fail with
 * `ScriptFailed`.
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
type SystemError<T> = T extends System.System<infer E, unknown> ? E : never;

type SystemNeeds<T> = T extends System.System<unknown, infer R> ? R : never;

/** The parts of a handler the types below read. */
interface HandlerOf<N extends string, P, A, E, R> {
  readonly action: { readonly name: N };
  readonly handle: (payload: P, ...rest: never) => Effect.Effect<A, E, R>;
}

type HandlerNeeds<T> =
  T extends HandlerOf<string, never, unknown, unknown, infer R> ? R : never;

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

type HandlerFor<HU, N extends string> = Extract<
  HU,
  { readonly action: { readonly name: N } }
>;

type PayloadFor<HU, N extends string> =
  HandlerFor<HU, N> extends HandlerOf<
    string,
    infer P,
    unknown,
    unknown,
    unknown
  >
    ? P
    : never;

type ResultFor<HU, N extends string> =
  HandlerFor<HU, N> extends HandlerOf<string, never, infer A, unknown, unknown>
    ? A
    : never;

type FailureFor<HU, N extends string> =
  HandlerFor<HU, N> extends HandlerOf<string, never, unknown, infer E, unknown>
    ? E
    : never;

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
   * The pairs of tick systems whose order matters but isn't specified: both
   * touch the same component, singleton, state or event, at least one of them
   * writes it, and only the order they were listed in decides which runs first.
   * `System.conflicts` explains how it is computed. Only systems that declared
   * their access with `System.access` can appear. Resolve a conflict with
   * `System.after` or `System.before`, and assert in a test that the list is
   * empty.
   */
  readonly conflicts: readonly System.Conflict[];
  /**
   * The names of the tick's systems, hooks included, that haven't declared
   * their access: `conflicts` knows nothing about them.
   */
  readonly undeclared: readonly string[];
  /**
   * Runs one tick. Throws if a system fails, or if the app has stopped.
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
   * false while an action is queued, a state transition is pending, a script is
   * waiting for the next tick or sleeping, a fiber is due, or an event is
   * waiting that some system hasn't had a chance to read. Reading it changes
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
   * throws. Throws if a system fails, or if the app has stopped. Only between
   * ticks.
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
   * fails, or if the app has stopped. Only between ticks.
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
   * Like `enqueue`, for actions that arrive as data. Problems become
   * `Action.Rejected` events.
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
   * outcome. Actions a system, a script or a handler issued with
   * `Actions.enqueue` aren't here, because a replay's own simulation issues
   * them again. It is enough to replay the game, and to verify the replay.
   */
  readonly actionLog: readonly Action.LogEntry[];
  /**
   * Saves the game as it is, to load later with `App.load`: the world, the
   * time, the actions queued for the next tick, the events waiting to be read,
   * what change queries haven't visited yet, and the length of the log. It
   * holds no scripts. Only between ticks.
   *
   * Fails with `SaveRefused`, which names what is in the way: a queued action
   * or a waiting event without a schema, a field holding a value that can't be
   * saved, or commands queued but not applied.
   */
  readonly save: () => Exit.Exit<Save.Save, Save.SaveRefused>;
  /**
   * Captures the game as it is, in memory, to return to with `rewind`: the
   * world, the time, the actions queued for the next tick, the events waiting
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
   * A moment holds what a save holds, and no more. Every script the app
   * supervises is interrupted, and each plugin's scripts restart from the
   * beginning, as after a load, so a script keeps whatever it must not lose in
   * the world. State held by your game's own services is left as is. A
   * `transient` field is undefined afterwards. And what runs between ticks
   * starts over: frame-stage and input-stage change queries visit everything
   * again.
   */
  readonly rewind: (moment: Moment) => void;
  /**
   * Records the world's hash in the action log now, and returns it. Use it for
   * points the game wants verified beyond the ones `checkpointEvery` records,
   * such as when it is saved. Only between ticks.
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
  /** Runs one tick, as `tickExit` did. It reads no device. */
  readonly tickExit: (delta: number) => Exit.Exit<void, E>;
}

/**
 * A running game: its world, its time, the actions queued for the next tick,
 * and what runs a tick and a frame. Made with `App.make`, `App.load` or, in a
 * page, `App.run`.
 *
 * `E` is what a tick can fail with, `R` what its systems need, and `HU` the
 * actions its handlers accept.
 *
 * @category Models
 */
export interface App<E = never, R = never, HU = never> extends Any {
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
   * `Exit`. An app stopped by a failed script runs nothing and returns a
   * defect, `ScriptFailed`.
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
   * Starts a long-running fiber (a coroutine). It runs immediately up to its
   * first wait, and from then on only advances during ticks. If it fails, the
   * failure is logged with its cause; see `onScriptFailure`.
   */
  readonly spawnScript: <A, E2>(
    effect: Effect.Effect<A, E2, R | BuiltIn>
  ) => Fiber.Fiber<A, E2>;
  /**
   * Applies an action now and returns the outcome. A refusal comes back as a
   * typed failure and leaves the game unchanged. An accepted action is logged;
   * a refused one isn't.
   *
   * For code outside the simulation, and only between ticks: it throws during a
   * tick, during the frame or input stage, and from a handler. It also throws
   * on an app a session has taken over, where it would advance this machine's
   * game alone: use `enqueue` instead.
   */
  readonly dispatch: <N extends ActionNames<HU>>(
    action: Action.ActionDef<N, PayloadFor<HU, N>, unknown>,
    payload: PayloadFor<HU, N>
  ) => Exit.Exit<ResultFor<HU, N>, FailureFor<HU, N>>;
  /**
   * Queues an action for the start of the next tick, and logs it. Use it for
   * real-time input. A refusal becomes an `Action.Rejected` event, and is
   * marked on the action's log entry.
   *
   * For code outside the simulation. A system, a script or a handler issues an
   * action with `Actions.enqueue`, which doesn't log it: if logged, it would be
   * applied twice on replay, once from the log and once by the replay's own
   * simulation. On an app a session has taken over, the action goes to every
   * peer, and one without a schema throws.
   */
  readonly enqueue: <N extends ActionNames<HU>>(
    action: Action.ActionDef<N, PayloadFor<HU, N>, unknown>,
    payload: PayloadFor<HU, N>
  ) => void;
}

/**
 * What a system with declared access is held to while it runs: `System.access`
 * covers everything it does, so anything it left out is refused where it
 * happens.
 */
interface Hold {
  /** For a message: `System "Movement"`. */
  readonly who: string;
  /** What the world refuses for its components, singletons and commands. */
  readonly world: Guard;
  /** What the bus refuses for its events. */
  readonly events: EventGuard;
  readonly random: boolean;
  readonly actions: boolean;
  readonly scripts: boolean;
}

/** The closing advice of a refusal: how a system declares more. */
const ADVICE =
  " A system that says what it reads and writes says all of it: add this to its System.access, or leave the system without one.";

/** Summarizes an error in a few words, for a log entry or a message. */
const describe = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

/**
 * A script failed in an app configured to stop on script failure. Every later
 * tick of that app fails with this defect.
 *
 * @category Errors
 */
export class ScriptFailed extends Data.TaggedError("ScriptFailed")<{
  /** Why the script failed. */
  readonly cause: Cause.Cause<unknown>;
  /** The number of ticks run when it failed. */
  readonly tick: number;
}> {
  override get message(): string {
    return `A script failed at tick ${this.tick}, and the app was told to stop on one: ${Cause.pretty(this.cause)}`;
  }
}

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
   * Components and singletons that belong to the app itself, not to a plugin. A
   * world identifies them by name, so loading a save requires every one it
   * contains to be listed here or by a plugin.
   */
  readonly components?: readonly Listed[];
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
   * What a script failure does, beyond being logged with its cause through
   * Effect's logger. `"log"`, the default, lets the game continue without the
   * script. `"stop"` stops the app: the tick the script failed in, and every
   * tick after it, fails with `ScriptFailed`, which stops a driver. An
   * interrupted script hasn't failed.
   */
  readonly onScriptFailure?: "log" | "stop";
  /**
   * Verifies that the frame and input stages leave the world unchanged: the
   * world's hash is taken before the stage and after each of its systems, and
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
 * An effect of a system, a handler, a plugin's setup or a script, to be run
 * with the app's context.
 */
const runnable = <A, E>(
  effect: Effect.Effect<A, E, unknown>
): Effect.Effect<A, E, never> =>
  // SAFETY: App.make's types require every service that its systems,
  // handlers, setups and scripts need to come from the caller, a plugin or
  // the app, and the app's context holds them all. Listed together, the
  // effects' own types no longer say which they need.
  effect as Effect.Effect<A, E, never>;

const refused = (message: string): Exit.Exit<never, Save.SaveRefused> =>
  Exit.fail(new Save.SaveRefused({ message }));

const noFrame = (): never => {
  throw new Error(
    "Frame was read by a system of the input stage. It tells the frame stage how far a frame is between two ticks; the input stage runs before a tick, and no frame is being drawn."
  );
};

const notInFrame = (what: string) => (): never => {
  throw new Error(
    `${what} was used in the frame stage or the input stage. A script runs in the tick and is part of the simulation; those stages run between ticks and finish at once.`
  );
};

const hookKey = (trigger: System.Trigger): string =>
  `${trigger.state.name}\n${trigger.on}\n${trigger.value}`;

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

/** Registers the components a plugin or the app lists. */
const registerAll = (world: EcsWorld, components: readonly Listed[]): void => {
  for (const listed of components) {
    if (isSingletonSpec(listed)) {
      world.singleton(listed);
    } else {
      world.register(listed);
    }
  }
};

const versionOf = (version = 0): number => {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(
      `A game's version must be a whole number from 0 up, and this one is ${version}.`
    );
  }

  return version;
};

const checkpointEveryOf = (every = 60): number => {
  if (!Number.isSafeInteger(every) || every < 0) {
    throw new Error(
      `checkpointEvery must be a whole number of ticks, 0 for none, and this one is ${every}.`
    );
  }

  return every;
};

/** What a save is loaded into. */
interface Restored {
  readonly world: EcsWorld;
  readonly time: TimeState;
  readonly events: EventBus;
}

/**
 * Brings a save up to this version of the game, then fills the empty world,
 * the clock and the bus from it. Returns the save as it is now.
 */
const restore = (
  into: Restored,
  given: Save.Save,
  version: number,
  migrations: readonly Save.Migration[] = []
): Effect.Effect<Save.Save, Save.LoadRefused> =>
  Effect.gen(function* () {
    const save = yield* Save.migrate(given, version, migrations);

    try {
      into.world.load(save.world);
      into.world.restoreChanges(save.changes);
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

    into.time.tick = save.tick;
    into.time.elapsed = save.elapsed;
    into.time.delta = save.delta;
    into.events.restore(save.events);

    return save;
  });

const handlersByName = (
  all: readonly Plugin.AnyHandler[]
): Map<string, Plugin.AnyHandler> => {
  const handlers = new Map<string, Plugin.AnyHandler>();

  for (const handler of all) {
    if (handlers.has(handler.action.name)) {
      throw new Error(`Two handlers for action "${handler.action.name}"`);
    }

    handlers.set(handler.action.name, handler);
  }

  return handlers;
};

/**
 * Returns the hooks, by the moment they run at, each moment's in order; and
 * gives every state the app knows of its handle in the world.
 */
const hooksOf = (
  world: EcsWorld,
  components: readonly Listed[],
  systems: readonly Plugin.AnySystem[]
): Map<string, Plugin.AnySystem[]> => {
  const hooks = new Map<string, Plugin.AnySystem[]>();

  for (const listed of components) {
    if (listed instanceof State.State) {
      State.handleOf(world, listed);
    }
  }

  for (const system of systems) {
    if (system.trigger === undefined) {
      continue;
    }

    // SAFETY: a trigger is made by State.onEnter or State.onExit, of a state.
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

  return hooks;
};

/** Returns what each system that said what it touches is held to, by name. */
const holdsOf = (systems: readonly Plugin.AnySystem[]): Map<string, Hold> => {
  const holds = new Map<string, Hold>();

  for (const system of systems) {
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

  return holds;
};

/** How loading a save can fail, when there is one to load. */
type LoadFailure<SV extends Save.Save | undefined> = SV extends Save.Save
  ? Save.LoadRefused
  : never;

const build = <
  S extends Systems,
  H extends Handlers,
  P extends Plugins,
  SV extends Save.Save | undefined,
>(
  options: Options<S, H, P>,
  given: SV
): Effect.Effect<
  App<TickError<S, P>, Provided<P> | External<S, H, P>, AllHandlers<H, P>>,
  Plugin.ErrorOf<P[number]> | LoadFailure<SV>,
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

    const nextTick: Effect.Effect<void> = Effect.callback((resume) => {
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
    const scripts = new Set<Fiber.Fiber<unknown, unknown>>();
    const stopOnFailure = options.onScriptFailure === "stop";
    let stopped: ScriptFailed | undefined;
    // Reports are logged with the app's context once it is built, so they
    // reach the loggers the caller provided.
    let reportContext: Context.Context<never> = Context.empty();

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

    registerAll(world, components);
    const version = versionOf(options.version);

    // Before anything else can touch the world: a load fills an empty one.
    // SAFETY: a load fails only where there is a save, and there SV is a Save.
    const save =
      given === undefined
        ? undefined
        : yield* restore(
            { events, time, world },
            given,
            version,
            options.migrations
          ) as Effect.Effect<Save.Save, LoadFailure<SV>>;

    const allSystems = [
      ...plugins.flatMap((plugin) => plugin.systems),
      ...(options.systems ?? []),
    ];

    const handlers = handlersByName([
      ...plugins.flatMap((plugin) => plugin.handlers),
      ...(options.handlers ?? []),
    ]);

    // `encoded` says which form the payload is in: the JSON form that arrives
    // from outside, or the value a handler works with. `entry` is the log
    // entry of an action that was enqueued from outside the simulation; one
    // that a system, a script or a handler issued has none.
    const queued: {
      readonly name: string;
      readonly payload: unknown;
      readonly encoded: boolean;
      readonly entry: { refused?: string } | undefined;
      /** The issuer, if it came with a name. */
      readonly from: string | undefined;
    }[] = [];

    if (save !== undefined) {
      // In the JSON form they were saved in, checked again when applied.
      for (const { from, name, payload } of save.queued) {
        queued.push({ name, payload, encoded: true, entry: undefined, from });
      }
    }

    const actionLog: Action.LogEntry[] = [];
    // The moments this app has captured, each kept as what it holds:
    // `rewind` takes no other.
    const moments = new WeakMap<Moment, Captured>();

    /** What a moment holds beyond its tick. */
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

    const checkpointEvery = checkpointEveryOf(options.checkpointEvery);

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

    const handles = (action: { readonly name: string }): boolean =>
      handlers.has(action.name);

    // Who has taken over what comes from outside, if anyone has: `divert`.
    let diverted: ((name: string, payload: unknown) => void) | undefined;

    /** Enqueues from outside the simulation: `app.enqueue`. */
    const enqueue = (
      action: { readonly name: string },
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

    /** Refuses an action issued by a system whose declared access doesn't include actions. */
    const refuseAction = (name: string): void => {
      if (held !== undefined && !held.actions) {
        throw new Error(
          `${held.who} issued the action "${name}", and did not say it issues actions: actions: true.${ADVICE}`
        );
      }
    };

    /**
     * Enqueues from inside the simulation: the `Actions` service. Not logged,
     * because a replay's own systems, scripts and handlers issue it again.
     */
    const enqueueFromInside = (
      action: { readonly name: string },
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
    // Whether the game asked for its next tick: `Ticks.more`. An app that
    // has not ticked yet has not been asked, and is taken to want one.
    let wanted = true;

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
    let layer: Layer.Layer<never, unknown, unknown> =
      Layer.succeedContext(builtIns);

    for (const plugin of plugins) {
      if (plugin.layer !== undefined) {
        layer = Layer.provideMerge(plugin.layer, layer);
      }
    }

    const built = yield* Layer.build(
      // SAFETY: the built-in services' layer with every plugin's merged in,
      // and a plugin's layer provides, fails with and needs what its type
      // says it does.
      layer as Layer.Layer<
        BuiltIn | Provided<P>,
        Plugin.ErrorOf<P[number]>,
        External<S, H, P>
      >
    );

    // Everything the caller provided (their services, resource overrides, the
    // scope) is captured once here and handed to every system and script.
    const provided = yield* Effect.context<External<S, H, P>>();

    // Putting our scheduler in the context makes every fiber started from it
    // (systems, handlers, scripts, and anything they fork) use the tick dispatcher.
    const context = Context.merge(provided, built).pipe(
      Context.add(Scheduler.Scheduler, scheduler)
    );

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

    const states = State.registryOf(world);
    const hooks = hooksOf(world, components, allSystems);

    // --- what a system said it reads and writes -----------------------------------
    // A system that said it, with `System.access`, is held to it while it
    // runs: the world and the bus are told what it may touch, and refuse
    // the rest where it is done. One that has not said is held to nothing.
    const holds = holdsOf(allSystems);

    const randomWas = new Uint32Array(4);

    /** Holds the next runner to its declared access, if it declared one. */
    const hold = (to: Hold | undefined): void => {
      held = to;
      world.guard = to?.world;
      events.guard = to?.events;

      if (to !== undefined && !to.random) {
        randomWas.set(world.random.state);
      }
    };

    /** Called after the system has run. An undeclared random draw is detected here. */
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

    /** Runs one system as itself, with its own positions in events and changes. */
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
            : Effect.flatMap(system.condition, (met) =>
                met ? system.run : (system.idle ?? Effect.void)
              ),
          release
        );
      });

    /** Makes one state transition: the exit hooks, the transition, then the enter hooks. */
    const makeMove = Effect.fnUntraced(function* (
      state: State.AnyState,
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

    // Beside `ordered`: what each is held to, so that a system that has
    // not said costs a tick one read of this.
    const orderedHolds = ordered.map((system) => holds.get(system.name));

    const tickEffect = Effect.gen(function* () {
      if (states.states.length > 0) {
        yield* enterStates;
      }

      for (let at = 0; at < ordered.length; at += 1) {
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
          if (system.idle === undefined) {
            release();
          } else {
            yield* system.idle;
            release();
            commands.apply();
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
        enqueue: (action, payload) => {
          refuseAction(action.name);
          enqueue(action, payload);
        },
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
    );

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
    );

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
        const fibers = [...scripts];

        for (const fiber of fibers) {
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

    const busy = (): string => {
      if (ticking) {
        return "tick";
      }

      return between === "input" ? "run of the input stage" : "frame";
    };

    // The action whose handler is running, if one is.
    let applying: string | undefined;

    /** Rolls back everything a handler did since the three marks were taken. */
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
          ({ value } = converted);
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
        fiber = runFork(
          runnable(
            handler.handle(
              // SAFETY: the payload is the handler's action's: `dispatch` is
              // typed by the action, and a payload from the log or another
              // peer was decoded by the action's codec above.
              value as never,
              { from }
            )
          )
        );
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

    /** Runs one of the two between-ticks stages, with the world frozen. */
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
            ? runFrameFork(runnable(frameEffect))
            : runInputFork(runnable(inputEffect));

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

        // SAFETY: every system of the stage is one of S, or of a plugin of P,
        // and fails as its type says.
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
      frame.count += 1;

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

    /** Applies the actions queued since the last tick, in order. */
    const applyQueued = (): void => {
      if (queued.length === 0) {
        return;
      }

      for (const { encoded, entry, from, name, payload } of queued.splice(0)) {
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
    };

    const runTick = (
      delta: number,
      tickOptions?: TickOptions
    ): Exit.Exit<void, TickError<S, P>> => {
      if (ticking || between !== undefined) {
        throw new Error(`App.tick was called from inside a ${busy()}`);
      }

      if (stopped !== undefined) {
        return Exit.die(stopped);
      }

      // A tick hears the devices first. Whoever steps the app may have
      // seen to it, as a driver does; if not, it is seen to here.
      if (!heard && inputSystems.length > 0 && tickOptions?.input !== false) {
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
        applyQueued();

        time.delta = delta;
        time.elapsed += delta;
        time.tick += 1;

        events.beginTick();
        const fiber = runFork(runnable(tickEffect));
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
          const batch = [...waiters];
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

          rounds += 1;

          if (rounds > dispatcher.maxRounds) {
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

        // SAFETY: every system of the tick is one of S, or of a plugin of P,
        // and fails as its type says.
        return exit as Exit.Exit<void, TickError<S, P>>;
      } finally {
        ticking = false;
      }
    };

    const tickExit = (
      delta: number,
      tickOptions?: TickOptions
    ): Exit.Exit<void, TickError<S, P>> => {
      if (diverted !== undefined) {
        throw new Error(
          "App.tick was called on an app that a session has taken over. It would move this machine's game a tick ahead of the other peers'. The session steps the app: call the session's tick, or give the session to the driver."
        );
      }

      return runTick(delta, tickOptions);
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
          queued: [...queued],
          logLength: actionLog.length,
          started,
          wanted,
        };

        moments.set(moment, moment);

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

        const was = moments.get(moment);

        if (was === undefined) {
          throw new Error(
            "rewind() was given a moment that this app did not capture. A moment is of one app, in one run of the program: to bring a game back from elsewhere, save it and load the save."
          );
        }

        // The scripts first: none of them is part of what was captured.
        // Copied first: interrupting a fiber removes it from the set.
        const fibers = [...scripts];

        for (const fiber of fibers) {
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
        ({ started, wanted } = was);
        heard = false;
        stopped = undefined;

        // As after a load: each plugin's scripts, from their beginning.
        for (const plugin of plugins) {
          for (const script of plugin.scripts) {
            watch(runFork(runnable(script)));
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
      tick(delta, tickOptions) {
        const exit = tickExit(delta, tickOptions);

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
      spawnScript<A, E2>(
        effect: Effect.Effect<A, E2, Provided<P> | External<S, H, P> | BuiltIn>
      ) {
        return watch(runFork(runnable(effect)));
      },
      dispatch<N extends ActionNames<AllHandlers<H, P>>>(
        action: Action.ActionDef<N, PayloadFor<AllHandlers<H, P>, N>, unknown>,
        payload: PayloadFor<AllHandlers<H, P>, N>
      ) {
        assertBetweenTicks(action.name);

        // A typed dispatch of an action nobody handles is a programming error.
        if (!handlers.has(action.name)) {
          throw new Error(`No handler for action "${action.name}"`);
        }

        // SAFETY: the handler of an action named N is the one in the app's
        // handlers whose action is named N, so it returns that handler's
        // result or fails with its error.
        return apply(action.name, payload, false, true, undefined) as Exit.Exit<
          ResultFor<AllHandlers<H, P>, N>,
          FailureFor<AllHandlers<H, P>, N>
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
      const fiber = runFork(runnable(plugin.setup));
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
        // SAFETY: a plugin's setup fails as its type says.
        return yield* exit as Exit.Exit<never, Plugin.ErrorOf<P[number]>>;
      }

      commands.apply();
    }

    // Then every plugin's scripts, on a fresh start and after a load alike:
    // a script runs up to its first wait, and from then on during ticks.
    for (const plugin of plugins) {
      for (const script of plugin.scripts) {
        watch(runFork(runnable(script)));
      }
    }

    commands.apply();

    return app;
  });

/**
 * Starts a fresh game: every plugin's `setup` runs, then its scripts start.
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
> => build(options, undefined);

/**
 * Restores a game from a save: its world, its time, the actions queued for the
 * next tick and the events waiting to be read. Pass the plugins and options the
 * game was created with.
 *
 * No plugin's `setup` runs, since the save holds what setup spawned. Every
 * plugin's scripts restart from the beginning, since a save can't hold a script
 * mid-flight.
 *
 * The app's action log starts empty. Replay what the game logged after the save
 * (`log.slice(save.logLength)`) with `App.replay`, which verifies it against
 * the log's checkpoints as it goes.
 *
 * Fails with `LoadRefused` when the save's world can't be loaded: it contains a
 * component no plugin lists, or one whose fields have changed, or its bytes are
 * damaged. It also fails when the save is from another version of the game and
 * `migrations` don't bring it up to this one: see `Save.migrate`.
 *
 * **Gotchas**
 *
 * - A script started by hand, with `app.spawnScript` or `Script.spawn`, isn't
 *   restarted: whoever loads the game starts it.
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
  App<TickError<S, P>, Provided<P> | External<S, H, P>, AllHandlers<H, P>>,
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
 * running: no pending frame, no script, and everything the plugins' layers and
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
  );

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
 * Re-applies a recorded action log to a fresh app, ticking with a fixed delta.
 * With the same systems, the same seed and the same starting state, the result
 * is the same game.
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
 * Actions the game's systems, scripts and handlers issued aren't in the log:
 * the replay's own simulation issues them again.
 *
 * **Gotchas**
 *
 * - The log doesn't record the delta or the number of ticks, nor when a script
 *   was started by hand with `app.spawnScript`: whoever replays supplies them.
 * - It runs neither the frame stage nor the input stage: every tick runs with
 *   `{ input: false }`.
 * - A log without checkpoints, from an app created with `checkpointEvery: 0`,
 *   is verified by its actions alone: a replay that has diverged runs until an
 *   action happens to be refused, or to the end.
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
          // SAFETY: no session has taken over the replay's app, so queueing
          // an action logs it, last.
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

      next += 1;
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

  for (let i = 0; i < options.ticks; i += 1) {
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
