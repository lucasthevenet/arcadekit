/**
 * The app ties the pieces together: a world, the built-in services, plugins, an
 * ordered list of systems, action handlers, and a `tick`.
 *
 * Services come from plugins' layers. Anything systems and handlers need that
 * no plugin provides is an ordinary Effect requirement of `App.make`:
 *
 *   App.make(App.define({ plugins, systems })).pipe(Effect.provide(AudioLive))
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
import { Effect, Exit } from "effect";
import type { Scope } from "effect";

import * as Action from "./Action";
import { build } from "./Build";
import type { Entity } from "./ecs/component";
import type { Placed } from "./ecs/spawned";
import * as Journal from "./Journal";
import * as Plugin from "./Plugin";
import * as Save from "./Save";
import type { BuiltIn, Time, TimeState, World } from "./Services";
import * as System from "./System";

/** @internal The systems of a game, of any type. */
export type Systems = readonly Plugin.AnySystem[];
/** @internal The handlers of a game, of any type. */
export type Handlers = readonly Plugin.AnyHandler[];
/** @internal The plugins of a game, of any type. */
export type Plugins = readonly Plugin.Any[];

// Distributive on purpose: an empty list must give `never`, not `unknown`.
type SystemError<T> = T extends System.System<infer E, unknown> ? E : never;
type SystemNeeds<T> = T extends System.System<unknown, infer R> ? R : never;
type HandlerNeeds<T> =
  T extends Action.Handler<string, infer _P, unknown, unknown, infer R>
    ? R
    : never;

/** @internal What a tick of a game can fail with: what its systems fail with. */
export type TickError<S extends Systems, P extends Plugins> =
  | SystemError<S[number]>
  | Plugin.TickErrorOf<P[number]>;
/** @internal A game's handlers, its plugins' among them, as a union. */
export type AllHandlers<H extends Handlers, P extends Plugins> =
  | H[number]
  | Plugin.HandlerOf<P[number]>;
type Provided<P extends Plugins> = Plugin.ProvidedOf<P[number]>;

/**
 * What must come from outside: whatever systems, handlers and setups need that
 * neither a plugin nor the app provides, plus whatever plugin layers need that
 * their declared dependencies don't provide.
 *
 * @internal
 */
export type External<
  S extends Systems,
  H extends Handlers,
  P extends Plugins,
> =
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
 * `app.read` is told this of an effect that requires more than reading.
 *
 * @category Type-level
 */
export type Readable<R> = [Exclude<R, Reads>] extends [never]
  ? unknown
  : {
      readonly "Code outside the game reads it, with World, Time, a query that only reads, a singleton or a state, and changes it with an action: app.enqueue or app.dispatch.": Exclude<
        R,
        Reads
      >;
    };

/** What `app.read` provides. */
type Reads = World | Time;

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
  readonly time: Readonly<TimeState>;
  /**
   * Reads the game from outside it: runs `effect` with the services that
   * read, `World` and `Time`, and nothing that changes the game. A query that
   * only reads, a singleton and a state's value are read the same way.
   *
   *   const world = yield* app.read(World)
   *   world.get(rock, Position)?.x
   *   const score = yield* app.read(Score)
   *
   * Code outside the game changes it with an action alone, `enqueue` or
   * `dispatch`, which the log holds and a replay repeats, so `effect` can
   * require nothing that writes: a query with `Query.writes`, `Commands`,
   * `World.writes`, an event, `State.sets` or `Singleton.writes` don't
   * compile, and the error says so. Only between ticks.
   */
  readonly read: <A, E, R>(
    effect: Effect.Effect<A, E, R> & Readable<R>
  ) => Effect.Effect<A, E>;
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
   * A tick reads no device. The input stage, `input`, is what reads them, and
   * a driver runs it before each tick: code that steps its app by hand calls
   * `app.input()` before a tick that is to hear the devices.
   */
  readonly tick: (delta: number) => void;
  /**
   * Whether the game is at rest: its last tick changed nothing but its
   * time, and a tick now would find no pending work. It is false while an
   * action is queued or was dispatched since the last tick, a state
   * transition is pending, a fiber is due, or an event is waiting that some
   * system hasn't had a chance to read. Reading it changes nothing of the
   * game.
   *
   * A driver set to tick only when needed checks it, so a game that moves
   * only when its player does stands still in between, and one with a clock
   * running or a body in flight ticks for as long as they change the world.
   * An app that hasn't ticked yet, new or just loaded, isn't settled.
   *
   * **Gotchas**
   *
   * - From the first time it is read, the app hashes its world after every
   *   tick to tell whether it changed: about 10 µs for a thousand entities.
   * - A system that waits for a moment of game time by comparing it with
   *   `Time`, and writes nothing meanwhile, is never reached: game time
   *   stands still at rest. Count down in the world instead.
   */
  readonly settled: boolean;
  /**
   * Runs the frame stage once: the systems made with `System.frame`,
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
   * Runs the input stage once: the systems made with `System.input`,
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
   * The game as it was played, to play again with `Journal.replay`: how it began,
   * the action log, the delta of every tick, and the ticks it begins and ends
   * at. It begins where this app began, from its seed or from the save it was
   * made from, or at `since`, a save this app made, which the recording then
   * holds: replaying it returns to the present from that save. Only between
   * ticks.
   *
   * An app made from a save keeps that save for as long as it lives, to
   * record from.
   */
  readonly record: (since?: Save.Save) => Journal.Recording;
  /**
   * Saves the game as it is, to load later with `App.make(game, { save })`: the world, which
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
   * queued for the next tick, as `{ queued }`, and under
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

/**
 * A running game: its world, its time, the actions queued for the next tick,
 * and what runs a tick and a frame. Made with `App.make`, and run in a page
 * with `Driver.run`.
 *
 * `E` is what a tick can fail with, and `HU` the actions its handlers accept.
 *
 * @category Models
 */
export interface App<E = never, HU = never> extends Any {
  /**
   * Runs one tick and returns the outcome, with system failures as a typed
   * `Exit`.
   */
  readonly tickExit: (delta: number) => Exit.Exit<void, E>;
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
  ) => Exit.Exit<Placed<ResultFor<HU, N>>, FailureFor<HU, N>>;
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
 * An app that something else steps: a session's, which runs a tick when
 * every peer may, or a sync test's. It is the app without what would move
 * this machine's game alone: `tick`, `tickExit`, `dispatch` and
 * `dispatchByName`. Its world, its time, its frame and input stages, its
 * log, its saves and its recordings are an app's, and an action given to
 * `enqueue` is applied when the one that steps it says.
 *
 * `E` is what a tick can fail with, and `HU` the actions its handlers accept.
 *
 * @category Models
 */
export type Steered<E = never, HU = never> = Omit<
  App<E, HU>,
  "dispatch" | "dispatchByName" | "tick" | "tickExit"
>;

/**
 * What a game is, as `App.define` takes it: its plugins, its own systems and
 * handlers, and its version. Nothing here differs from one run of the game
 * to the next.
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
   * `App.make` loads a save of this version as is, migrates an older one with
   * `migrations`, and refuses a newer one.
   */
  readonly version?: number;
  /**
   * How a save of an older version becomes one of the next: one migration per
   * version, each from `from` to `from + 1`. Only a game made from a save
   * uses them.
   */
  readonly migrations?: readonly Save.Migration[];
  /** Systems and handlers that belong to the app itself, not to a plugin. */
  readonly systems?: readonly [...S];
  readonly handlers?: readonly [...H];
}

/**
 * A game as a value: what every run of it shares, and nothing that differs
 * between two of them. `App.define` makes one, and `App.make` is given it
 * to make an app.
 *
 * It holds no world and no services, and making one runs nothing.
 *
 * @category Models
 */
export interface Game<
  S extends Systems = readonly [],
  H extends Handlers = readonly [],
  P extends Plugins = readonly [],
> {
  readonly plugins: readonly [...P];
  readonly systems: readonly [...S];
  readonly handlers: readonly [...H];
  /** The game's version, 0 when it was given none. */
  readonly version: number;
  readonly migrations: readonly Save.Migration[];
}

/**
 * Defines a game: its plugins, its own systems and handlers, its version and
 * the migrations of its saves.
 *
 *   const Duel = App.define({ plugins: [Game], version: 3 })
 *
 *   const app = yield* App.make(Duel, { seed: 1 })
 *
 * Define a game once and give the same value to everything that runs it, so
 * that a game played, a game loaded and the peers of a match are one game by
 * construction.
 *
 * Its systems run in the order they are listed, its plugins' ahead of its own.
 * A list in which a system watches a component ahead of one that writes it
 * doesn't compile, and the error says which goes after which: see
 * `System.Misordered`.
 *
 * @category Constructors
 */
export const define = <
  S extends Systems = readonly [],
  H extends Handlers = readonly [],
  P extends Plugins = readonly [],
>(
  options: Options<S, H, P> &
    System.Ordered<
      System.Listing<Plugin.SystemsOf<P>, S>,
      Plugin.Clashes<P, H, S>
    >
): Game<S, H, P> => ({
  plugins: options.plugins ?? ([] as unknown as readonly [...P]),
  systems: options.systems ?? ([] as unknown as readonly [...S]),
  handlers: options.handlers ?? ([] as unknown as readonly [...H]),
  version: Save.versionOf(options.version),
  migrations: options.migrations ?? [],
});

/**
 * One run of a game, as `App.make` takes it: where it starts,
 * and how much it checks of itself as it goes.
 *
 * A recording says where its game started in the same words, a `seed` or a
 * `save`, and `Journal.replay` makes its app from that, with the rest of
 * these as its `Journal.ReplayOptions`.
 *
 * @category Options
 */
export interface StartOptions<SV extends Save.Save | undefined = undefined> {
  /**
   * Where the app's random sequence starts: an integer from 0 to
   * `Number.MAX_SAFE_INTEGER`. Defaults to 0. Two apps with the same seed draw
   * the same numbers from `Random`, and a replay needs the seed its game was
   * played with. Not with `save`, which holds where the sequence had got to.
   */
  readonly seed?: SV extends Save.Save ? never : number;
  /**
   * A save to continue from, in place of a fresh start: its world, its time,
   * the actions queued for the next tick and the events waiting to be read.
   * No plugin's `setup` runs, since the save holds what setup spawned.
   */
  readonly save?: SV;
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
 * Makes an app that runs a game: a fresh one, in which every plugin's `setup`
 * runs, or with `save`, one that continues from a save.
 *
 *   const app = yield* App.make(Duel, { seed: 1 })
 *   const again = yield* App.make(Duel, { save })
 *
 * From a save, the app's action log starts empty. To return to where the game
 * had got to, replay what it recorded since the save, `app.record(save)`, with
 * `Journal.replay`, which verifies it against the log's checkpoints as it goes.
 *
 * With `save`, it fails with `LoadRefused` when the save's world can't be
 * loaded: it contains a component this program doesn't define, or one whose
 * fields have changed, or its bytes are damaged. It also fails when the save
 * is from another version of the game and the game's `migrations` don't bring
 * it up to this one: see `Save.migrate`.
 *
 * It listens to the devices of `Input.Source`, and with `Sound.plugin` opens
 * `Sound.Output`, in the scope it runs in, wherever their layers are provided,
 * and lets go of both when that scope closes: run the app in the program that
 * made it.
 *
 * **Gotchas**
 *
 * - State kept outside the world, in a variable of a module, isn't in a save,
 *   and a `transient` field is undefined after one is loaded.
 *
 * @category Constructors
 */
export const make = <
  S extends Systems = readonly [],
  H extends Handlers = readonly [],
  P extends Plugins = readonly [],
  SV extends Save.Save | undefined = undefined,
>(
  game: Game<S, H, P>,
  start?: StartOptions<SV>
): Effect.Effect<
  App<TickError<S, P>, AllHandlers<H, P>>,
  Plugin.ErrorOf<P[number]> | (SV extends Save.Save ? Save.LoadRefused : never),
  Scope.Scope | External<S, H, P>
> => {
  const given: StartOptions<SV> = start ?? {};
  return Effect.map(build(game, given), (built) => built.app);
};
