/**
 * The app runs a game. It holds the game's world, the built-in services and
 * the plugins, and runs the systems and the action handlers a tick at a time.
 *
 *   App.make(App.define({ plugins, systems })).pipe(Effect.provide(AudioLive))
 *
 * Services come from the plugins' layers. Anything that the frame and input
 * systems need and no plugin provides, such as `AudioLive` above, is an
 * ordinary Effect requirement of `App.make`. A missing one is the usual
 * Effect compile error.
 *
 * A tick runs these steps:
 *
 * 1. Apply the queued actions. A refused one becomes an `Action.Rejected`
 *    event.
 * 2. Advance the game's time.
 * 3. In one fiber, enter any requested states, which runs their exit and
 *    enter hooks. Then run every system in order, except those whose
 *    condition doesn't hold, and apply each system's queued commands after
 *    it runs.
 * 4. Drop the events that every system has seen.
 *
 * The action log records the world's hash before the first action or tick,
 * and at the end of every `checkpointEvery`th tick.
 *
 * Between ticks, `frame` runs the systems of the frame stage, which draw the
 * game and receive how far the frame is between two ticks. Just before a
 * tick, `input` runs the systems of the input stage, which receive the
 * devices' state and turn it into actions. The world is frozen in both
 * stages, so their systems can't change it.
 *
 * An app sends what it does as spans at the "Debug" level when the program
 * provides a tracer, such as `OtlpTracer.layer` of `effect/observability`:
 *
 * - `arcadekit/tick` for each tick, which holds an `action:<name>` span for
 *   each action applied in it, and a span for each system's turn, named after
 *   the system.
 * - `arcadekit/frame` for each run of the frame stage, and `arcadekit/input`
 *   for each run of the input stage, which hold a span for each of their
 *   systems.
 *
 * Each of these starts a trace of its own. A span costs about 3 µs. An app
 * makes no span, and costs nothing, when no tracer is provided, under
 * `Effect.withTracerEnabled(false)`, or when `Tracer.MinimumTraceLevel` is
 * above "Debug". A program that sends spans of its own and not the game's
 * provides `Tracer.MinimumTraceLevel` as "Info". A span reads the real clock
 * and draws its ids from `Math.random`, so tracing doesn't change the game.
 */
import { Data, Effect } from "effect";
import type { Scope } from "effect";

import * as Action from "./Action.ts";
import type { Entity } from "./ecs/component.ts";
import type { Placed } from "./ecs/spawned.ts";
import { build } from "./internal/build.ts";
import { versionOf } from "./internal/save.ts";
import * as Journal from "./Journal.ts";
import * as Plugin from "./Plugin.ts";
import * as Save from "./Save.ts";
import type { BuiltIn, Time, TimeState, World } from "./Services.ts";
import * as System from "./System.ts";

/**
 * The systems of a game, of any type.
 *
 * @category Type-level
 */
export type Systems = readonly Plugin.AnySystem[];
/**
 * The handlers of a game, of any type.
 *
 * @category Type-level
 */
export type Handlers = readonly Plugin.AnyHandler[];
/**
 * The plugins of a game, of any type.
 *
 * @category Type-level
 */
export type Plugins = readonly Plugin.Any[];

// Distributive on purpose: an empty list must give `never`, not `unknown`.
type SystemError<T> = T extends System.System<infer E, unknown> ? E : never;
type SystemNeeds<T> = T extends System.System<unknown, infer R> ? R : never;
type HandlerNeeds<T> =
  T extends Action.Handler<string, infer _P, unknown, unknown, infer R>
    ? R
    : never;

/**
 * What a tick of a game can fail with: what its systems fail with.
 *
 * @category Type-level
 */
export type TickError<S extends Systems, P extends Plugins> =
  | SystemError<S[number]>
  | Plugin.TickErrorOf<P[number]>;
/**
 * A game's handlers, its plugins' among them, as a union.
 *
 * @category Type-level
 */
export type AllHandlers<H extends Handlers, P extends Plugins> =
  | H[number]
  | Plugin.HandlerOf<P[number]>;
type Provided<P extends Plugins> = Plugin.ProvidedOf<P[number]>;

/**
 * What must come from outside: whatever systems, handlers and setups need that
 * neither a plugin nor the app provides, plus whatever plugin layers need that
 * their declared dependencies don't provide. A scope is never among them,
 * because the app has its own.
 *
 * @category Type-level
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
      Provided<P> | BuiltIn | Scope.Scope
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
/** What the game's handlers refuse an action with, of every action. `HU` is a union of handlers. */
type Refusals<HU> =
  HU extends Action.Handler<string, infer _P, unknown, infer E, unknown>
    ? E
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
 * The type that makes `app.read` refuse an effect that requires more than
 * reading. The compile error names what else the effect requires, and says
 * how code outside the game changes it.
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
 * The part of an app that doesn't depend on its systems or handlers, which
 * every app satisfies. Each of its methods returns an Effect, and the rest
 * are values to read.
 *
 *   yield* app.tick(1 / 60)
 *   const save = yield* app.save()
 *
 * **When to use**
 *
 * Use for code that works with any app.
 *
 * **Details**
 *
 * A call made where it may not be, such as `app.tick` from inside a tick,
 * dies with a message that says where it was made. Nothing is to handle
 * there: it is a bug in the code that made it.
 *
 * @category Models
 */
export interface Any {
  readonly time: Readonly<TimeState>;
  /**
   * Reads the game from outside it. It runs `effect` with the services that
   * read, `World` and `Time`, and nothing that changes the game. A query that
   * only reads, a singleton and a state's value are read the same way.
   *
   *   const world = yield* app.read(World)
   *   world.get(rock, Position)?.x
   *   const score = yield* app.read(Score)
   *
   * Code outside the game changes it only with an action, through `enqueue`
   * or `dispatch`, which the log holds and a replay repeats. So `effect` can
   * require nothing that writes. A query with `Query.writes`, `Commands`,
   * `World.writes`, an event, `State.sets` or `Singleton.writes` doesn't
   * compile, and the error says why. Run it only between ticks, since it
   * dies anywhere else.
   */
  readonly read: <A, E, R>(
    effect: Effect.Effect<A, E, R> & Readable<R>
  ) => Effect.Effect<A, E>;
  /** Installed plugin names, dependencies first. */
  readonly plugins: readonly string[];
  /** The names of the tick's systems, in the order they run. */
  readonly systemOrder: readonly string[];
  /** The names of the frame-stage systems, in the order they run. */
  readonly frameOrder: readonly string[];
  /** The names of the input-stage systems, in the order they run. */
  readonly inputOrder: readonly string[];
  /**
   * What the app is running right now. A game is stepped, saved, loaded,
   * captured, put back, recorded, checkpointed and inspected only in
   * `"idle"`. Each of
   * those dies in any other phase, which includes a handler that `dispatch`
   * runs, since a refusal takes back that handler's work.
   */
  readonly phase: Phase;
  /**
   * Runs one tick. It fails with what a system fails with. It dies if the
   * handler of a queued action dies or fails with an error its action
   * doesn't declare, or if a fiber started during the tick is still running
   * when the tick ends: one forked with `Effect.forkDetach`, `Effect.forkIn`
   * or into a scope of its own, which would change the game at a moment no
   * replay repeats.
   *
   * A tick reads no device. The input stage, `input`, reads them, and a
   * driver runs it before each tick. Code that steps its app by hand runs
   * `app.input()` before each tick that is to hear the devices.
   *
   *   yield* app.input()
   *   yield* app.tick(1 / 60)
   *   const ticked = yield* Effect.exit(app.tick(1 / 60))   // the outcome, as a value
   */
  readonly tick: (delta: number) => Effect.Effect<void, unknown>;
  /**
   * Whether the game is at rest, which means its last tick changed nothing
   * but its time and a tick now would find no pending work. It is false
   * while an action is queued or was dispatched since the last tick, while a
   * state transition is pending, while a fiber is due, or while an event
   * waits that some system hasn't had a chance to read. Reading it doesn't
   * change the game.
   *
   * A driver set to tick only when needed checks it. A game that moves only
   * when its player does then stands still in between, and one with a clock
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
   * Runs the frame stage once, the systems made with `System.frame`, which
   * draw the game as it is between two ticks. `alpha` is how far between the
   * two ticks the frame is, from 0 just after a tick up to 1 just before the
   * next. `delta` is the real seconds since the previous frame. Both reach
   * the systems as the `Frame` service. A driver calls `frame` after each
   * frame's ticks.
   *
   * Without an `alpha`, it is 1, so a game stepped by hand is drawn where its
   * last tick left it. At 0, what is drawn between two ticks, such as a kind
   * of `@arcadekit/three` with `smooth`, is still where it was before that
   * tick.
   *
   * The world is frozen while the stage runs, and anything that would change
   * the game throws. It fails with what a system fails with, and dies when
   * one leaves a fiber running, as `tick` does. Run it only between ticks,
   * since it dies anywhere else.
   */
  readonly frame: (
    alpha?: number,
    delta?: number
  ) => Effect.Effect<void, unknown>;
  /**
   * Runs the input stage once, the systems made with `System.input`, which
   * turn the devices' state into actions. It reads the devices once, and the
   * systems receive that one sample as `Input.Devices`. What they issue with
   * `Actions.enqueue` is logged and applied at the start of the next tick. A
   * driver and a session call `input` just before each tick, and a tick
   * doesn't call it. A replay doesn't call it either, since its log holds the
   * actions.
   *
   * The world is frozen while the stage runs, as for `frame`. It fails with
   * what a system fails with, and dies when one leaves a fiber running, as
   * `tick` does. Run it only between ticks, since it dies anywhere else.
   */
  readonly input: () => Effect.Effect<void, unknown>;
  /**
   * Like `dispatch`, for actions that arrive as data, such as network
   * messages, saved games and replays. It takes the payload in its JSON form
   * and validates it against the action's schema. An unknown name or an
   * invalid payload is a failure, `Action.Unknown` or
   * `Action.InvalidPayload`, and never a crash. `from` names the issuer, as
   * for `enqueueByName`.
   */
  readonly dispatchByName: (
    name: string,
    payload: unknown,
    from?: string
  ) => Effect.Effect<unknown, unknown>;
  /**
   * Like `enqueue`, for actions that arrive as data. Where it is run
   * decides whether the action is logged, as for `enqueue`. An unknown name
   * or an invalid payload becomes an `Action.Rejected` event when the action
   * is applied.
   *
   * `from` names the issuer, for code that brings actions in on someone
   * else's behalf, such as a server for its clients. The handler receives it,
   * and the log records it. Giving `from` dies on an app that a session has
   * taken over, where each peer's actions are stamped with that peer's own
   * name, and from the simulation, whose actions nobody issued.
   */
  readonly enqueueByName: (
    name: string,
    payload: unknown,
    from?: string
  ) => Effect.Effect<void>;
  /**
   * Every action that entered the game from outside, in arrival order, with
   * checkpoints of the world's hash among them. It holds every dispatched
   * action that was accepted, and every action enqueued as input, whatever
   * its outcome. It leaves out the actions that a system, a handler or a
   * plugin's setup enqueued, since a replay's own simulation issues them
   * again. The log is enough to replay the game and to verify the replay.
   */
  readonly actionLog: readonly Action.LogEntry[];
  /**
   * Returns the game as it was played, to play again with `Journal.replay`:
   * how it began, the action log, the delta of every tick, the ticks it
   * begins and ends at, and the world's hash where it ends. The recording
   * begins where this app began, from its seed or from the save it was made
   * from. With `since`, a save this app made, it begins at that save and
   * holds it, and replaying it returns to the present from that save. Run it
   * only between ticks, since it dies anywhere else.
   *
   * An app made from a save keeps that save for as long as it lives, to
   * record from.
   */
  readonly record: (since?: Save.Save) => Effect.Effect<Journal.Recording>;
  /**
   * Saves the game as it is, to load later with `app.load(save)` or
   * `App.make(game, { save })`.
   * The save holds the world and the length of the log. The world holds the
   * time, the actions queued for the next tick, the events waiting to be
   * read, and what the change queries haven't visited yet. Run it only
   * between ticks, since it dies anywhere else.
   *
   * It fails with `Save.Refused`, which names what is in the way: a
   * queued action or a waiting event whose payload its schema doesn't take, a
   * field that holds a value that can't be saved, or commands queued but not
   * applied.
   */
  readonly save: () => Effect.Effect<Save.Save, Save.Refused>;
  /**
   * Loads a save into this app, in place of the game it plays: the app, its
   * plugins' layers, its frame and input stages, its views and its sound stay
   * as they are, and its game is the one the save holds. The save is brought
   * up to the game's version with its migrations first, as `App.make` brings
   * one. Run it only between ticks, since it dies anywhere else.
   *
   *   const save = yield* app.save()
   *   yield* app.tick(1 / 60)
   *   yield* app.load(save)                // the game where it was saved
   *
   * The app is then the one `App.make(game, { save })` would make, ticks and
   * hashes as that one would, and is played by the same driver. Its action log
   * starts over, as that app's starts empty, and `app.record()` records from
   * the save. A moment captured before the load is refused by
   * `Timeline.rewind`. The frame and input stages, and code outside the game
   * that reads an event, hear the loaded game from then on, and their change
   * queries visit every entity again.
   *
   * It fails with `Save.LoadRefused` for a save the game can't load, as
   * `App.make` does, and the app is then as it was. It dies on an app that a
   * session has taken over, where it would move this machine's game alone.
   */
  readonly load: (save: Save.Save) => Effect.Effect<void, Save.LoadRefused>;
  /**
   * Records the world's hash in the action log now, and returns it. Use it for
   * points the game wants verified beyond the ones `checkpointEvery` records,
   * such as when it is saved. Run it only between ticks, since it dies
   * anywhere else.
   */
  readonly checkpoint: () => Effect.Effect<number>;
  /**
   * Copies what the game holds and what it did last as plain data, to read in
   * a debugger or the console, or to show in a game's own UI. The copy, an
   * `Inspection`, holds the entities and their components, the singletons,
   * the systems with how long each took, and the events of the last tick.
   * Calling it doesn't change the game.
   *
   * **Gotchas**
   *
   * - It copies the whole world, so run it when you look rather than every
   *   frame.
   * - It dies during a tick or a frame, so run it between ticks.
   */
  readonly inspect: () => Effect.Effect<Inspection>;
}

/**
 * What a game holds and what it did last, as `app.inspect()` gives it. Every
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
   * Every system, with the tick's in the order they run, then the hooks, the
   * input stage's and the frame stages'. Each entry says how the system's
   * last turn went. `ran` is false when a condition given with
   * `System.runIf` didn't hold, or when the system hasn't had a turn yet.
   * `ms` is how long the turn took in milliseconds, including its condition
   * and its commands.
   */
  readonly systems: readonly {
    readonly name: string;
    readonly stage: System.Stage;
    readonly ran: boolean;
    readonly ms: number;
  }[];
  /**
   * The events emitted in the last tick, and between it and the tick before,
   * by event name, each in the order it was emitted. An event that the
   * handler of a dispatched action emitted since the last tick isn't here
   * yet. It is listed with the next tick's.
   */
  readonly events: Readonly<Record<string, readonly unknown[]>>;
}

/**
 * A running game: its world, its time, the actions queued for the next tick,
 * and what runs a tick and a frame. `App.make` makes one, and `Driver.run`
 * runs it in a page.
 *
 * @typeParam E what a tick can fail with
 * @typeParam HU the app's handlers, as a union, which say what actions it
 *   accepts
 *
 * @category Models
 */
export interface App<E = never, HU = never> extends Any {
  /** Runs one tick, as `App.Any`'s `tick` does, and fails with what the game's systems fail with. */
  readonly tick: (delta: number) => Effect.Effect<void, E>;
  /** Runs the frame stage, as `App.Any`'s `frame` does, and fails with what a system fails with. */
  readonly frame: (alpha?: number, delta?: number) => Effect.Effect<void, E>;
  /** Runs the input stage, as `App.Any`'s `input` does, and fails with what a system fails with. */
  readonly input: () => Effect.Effect<void, E>;
  /**
   * Applies an action now, and succeeds with what its handler returns. A
   * refusal is a typed failure, and leaves the game unchanged. The log holds
   * an accepted action and leaves out a refused one.
   *
   *   const moved = yield* Effect.exit(app.dispatch(Move, { dx: 1 }))
   *
   * It is for code outside the simulation, between ticks. It dies during a
   * tick, during the frame or input stage, and from a handler. It also dies
   * on an app that a session has taken over, where it would advance this
   * machine's game alone, so use `enqueue` there. It dies, with the
   * handler's changes undone, when the handler leaves a fiber running, as
   * `tick` does.
   */
  readonly dispatch: <N extends ActionNames<HU>>(
    action: Action.Action<N, PayloadFor<HU, N>>,
    payload: PayloadFor<HU, N>
  ) => Effect.Effect<Placed<ResultFor<HU, N>>, FailureFor<HU, N>>;
  /**
   * Applies an action that arrives as data, as `App.Any`'s `dispatchByName`
   * does. It fails with what the game refuses an action with, with
   * `Action.Unknown` for a name the game has no handler for, and with
   * `Action.InvalidPayload` for a payload its schema doesn't take.
   */
  readonly dispatchByName: (
    name: string,
    payload: unknown,
    from?: string
  ) => Effect.Effect<
    unknown,
    Refusals<HU> | Action.Unknown | Action.InvalidPayload
  >;
  /**
   * Queues an action for the start of the next tick. A refusal when it is
   * applied becomes an `Action.Rejected` event. It is the same as
   * `Actions.enqueue`, and can be run from anywhere.
   *
   * Where it is run decides whether the action is logged. From outside
   * the simulation, between ticks, the action is input. The log holds it, a
   * refusal is marked on its log entry, and on an app that a session has
   * taken over it goes to every peer. From a system, a handler or a plugin's
   * setup, the action is the simulation's own and isn't logged, since a
   * replay's own simulation issues it again.
   *
   * It fails with `Action.InvalidPayload`, and queues nothing, when the
   * action's schema does not take the payload of an input action, which
   * could then be neither logged nor sent to the other peers.
   */
  readonly enqueue: <N extends ActionNames<HU>>(
    action: Action.Action<N, PayloadFor<HU, N>>,
    payload: PayloadFor<HU, N>
  ) => Effect.Effect<void, Action.InvalidPayload>;
  /**
   * Closes the app. It lets go of everything the app opened when it was
   * made: its plugins' layers, the devices it listens to, and the output it
   * plays through. A page's devices and its sound throw when used after, and
   * say that the app was closed. Closing the app again does nothing.
   *
   * Whatever runs the app closes it. `Driver.run` closes the app it made
   * when it ends or is interrupted. A program that makes an app itself
   * closes it when it is done with it.
   */
  readonly close: Effect.Effect<void>;
}

/**
 * An app that something else steps, such as a session, which runs a tick
 * when every peer may, or a sync test. It is the app without what would move
 * this machine's game alone: `tick`, `dispatch`, `dispatchByName` and
 * `load`. It has
 * no `close` either, because whatever steps it
 * closes it. Its world, time, frame and input stages, log, saves and
 * recordings are an app's. An action given to `enqueue` is applied when
 * whatever steps the app says. Its `enqueueByName` takes no `from`, since
 * whatever steps the app stamps who issued each action.
 *
 * @typeParam E what a tick can fail with
 * @typeParam HU the app's handlers, as a union, which say what actions it
 *   accepts
 *
 * @category Models
 */
export type Steered<E = never, HU = never> = Omit<
  App<E, HU>,
  "close" | "dispatch" | "dispatchByName" | "tick" | "enqueueByName" | "load"
> & {
  /** Like `App.enqueueByName`. A session stamps who issued it. */
  readonly enqueueByName: (
    name: string,
    payload: unknown
  ) => Effect.Effect<void>;
};

/**
 * What a game is, as `App.define` takes it: its plugins, its own systems and
 * handlers, its version and the migrations of its saves. Nothing here
 * differs from one run of the game to the next.
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
   * The game's version, an integer you increment when the game changes its
   * components or what its saves contain. Defaults to 0. A save records it.
   * `App.make` loads a save of this version as is, migrates an older one with
   * `migrations`, and refuses a newer one.
   *
   * At any version, a save whose components differ from the game's in
   * storage, field names, field order or field kinds is refused with
   * `"component changed"`. A change that keeps those, such as a field read in
   * other units or a `json` field holding another shape, loads with no error
   * unless the version is incremented with a migration that converts the old
   * values.
   */
  readonly version?: number;
  /**
   * How a save of an older version becomes one of the next: one migration per
   * version, each from `from` to `from + 1`. Only a game made from a save
   * uses them.
   */
  readonly migrations?: readonly Save.Migration[];
  /** The systems that belong to the game itself, not to a plugin. */
  readonly systems?: readonly [...S];
  /** The handlers that belong to the game itself, not to a plugin. */
  readonly handlers?: readonly [...H];
}

/**
 * A game as a value, which holds what every run of it shares and nothing
 * that differs between two runs. `App.define` makes one, and `App.make` makes
 * an app from it. It holds no world and no services, and making one runs
 * nothing.
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
 * **Details**
 *
 * Define a game once and give the same value to everything that runs it, so
 * that a game played, a game loaded and the peers of a match are one game by
 * construction.
 *
 * Its systems run in the order they are listed, with its plugins' ahead of
 * its own. A list in which a system watches a component ahead of one that
 * writes it doesn't compile, and the error says which goes after which. See
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
  version: versionOf(options.version),
  migrations: options.migrations ?? [],
});

/**
 * One run of a game, as `App.make` takes it: where it starts, and how much
 * it checks of itself as it goes.
 *
 * **Details**
 *
 * A recording says where its game started with the same `seed` or `save`.
 * `Journal.replay` makes its app from that, and takes the rest of these
 * options as its `Journal.ReplayOptions`.
 *
 * @category Options
 */
export interface StartOptions<SV extends Save.Save | undefined = undefined> {
  /**
   * Where the app's random sequence starts: an integer from 0 to
   * `Number.MAX_SAFE_INTEGER`. Defaults to 0. Two apps with the same seed draw
   * the same numbers from `Random`, and a replay needs the seed its game was
   * played with. It can't be given with `save`, which holds where the
   * sequence had got to.
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
   * of one world hash each time. Defaults to 60. A turn-based game wants 1,
   * and 0 records none.
   */
  readonly checkpointEvery?: number;
  /**
   * Checks what the compiler was told to let through. Use it in development
   * and tests.
   *
   * - `eachChunk` copies each column it hands out read-only, the fields of a
   *   term the query only reads and a relation's `target`, and compares it
   *   when the loop returns. A loop that wrote one throws, and the column is
   *   put back. This holds in every stage, the tick and an action's handler
   *   as much as the frame. It costs a copy and a comparison of each column.
   * - The app hashes the world before the frame or input stage and after each
   *   of its systems, without the actions queued for the next tick, which
   *   those stages are there to issue. If two hashes differ, `frame` or
   *   `input` dies with `App.FrameChangedWorld`, which names the system. It
   *   costs one world hash per system per frame.
   */
  readonly verifyFrames?: boolean;
}

/**
 * A frame-stage or input-stage system changed the world, which it must not do.
 * An app made with `verifyFrames` detects it. It is a defect, not a failure to
 * handle. Those stages run between ticks, and a game that depends on having
 * been drawn, or on its devices having been read, doesn't replay.
 *
 * @category Errors
 */
export class FrameChangedWorld extends Data.TaggedError(
  "AppFrameChangedWorld"
)<{
  /** The stage the system belongs to. */
  readonly stage: "frame" | "input";
  /** The system after which the world had changed. */
  readonly system: string;
  /**
   * The frame number, counted from 1. For the input stage, it is the last
   * frame drawn.
   */
  readonly frame: number;
}> {
  override get message(): string {
    return `The ${this.stage} stage changed the world: its hash was not the same after system "${this.system}" ran${this.stage === "frame" ? ` in frame ${this.frame}` : ""} as before. ${this.stage === "frame" ? "The frame stage draws the game between two ticks" : "The input stage reads the devices before a tick"} and must leave the world as it found it. Look for a draw from world.random, which is otherwise only found when the stage ends.`;
  }
}

/**
 * Makes an app that runs a game. A fresh app runs every plugin's `setup`, and
 * one made with `save` continues from that save instead.
 *
 *   const app = yield* App.make(Duel, { seed: 1 })
 *   const again = yield* App.make(Duel, { save })
 *
 * **Details**
 *
 * - To load a save into an app that is running, with its layers, its stages
 *   and its driver as they are, use `app.load(save)`.
 * - An app made from a save starts with an empty action log. To return to
 *   where the game had got to, replay what the first app recorded since the
 *   save, `app.record(save)`, with `Journal.replay`, which checks the
 *   recording against the log's checkpoints as it goes.
 * - With `save`, it fails with `Save.LoadRefused` when the save's world can't
 *   be loaded, because the world holds a component this program doesn't
 *   define or one whose fields have changed, or because its bytes are
 *   damaged. It also fails when the save is from another version of the game
 *   and the game's `migrations` don't bring it up to this one. See
 *   `Save.migrate`.
 * - The app has a scope of its own, which `app.close` closes, so making it
 *   requires none. In that scope it builds its plugins' layers and listens to
 *   the devices of `Input.Source`. With `Sound.plugin`, it also opens
 *   `Sound.Output` there. Each comes from wherever its layer is provided, and
 *   lasts until the app is closed, not until the effect that made the app
 *   ends. When the making fails, the app lets go of what it had opened at
 *   once.
 * - `Driver.run` closes the app it runs. A program that makes and runs an app
 *   itself closes it when it is done with it.
 *
 *   const app = yield* Effect.acquireRelease(App.make(Duel), (app) => app.close)
 *
 * **Gotchas**
 *
 * - State kept outside the world, in a variable of a module, isn't in a
 *   save, and a `transient` field is undefined after a save is loaded.
 * - An app that is never closed holds what it opened for as long as the
 *   program runs. In a page, the devices stay listened to and the page's
 *   audio stays open.
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
  External<S, H, P>
> => {
  const given: StartOptions<SV> = start ?? {};
  return Effect.map(build(game, given), (built) => built.app);
};
