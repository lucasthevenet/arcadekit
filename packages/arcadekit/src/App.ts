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
 *   3. run every system in order inside ONE fiber, applying queued commands
 *      after each system
 *   4. resume scripts that were waiting for this tick or for an event
 *   5. flush the scheduler, so every fiber that became runnable runs now
 *   6. apply commands queued by scripts, and drop events everyone has seen
 *
 * The world's hash is recorded in the action log before the first action or
 * tick, and at the end of every `checkpointEvery`th tick.
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
import type { ComponentDef } from "./ecs/component";
import { SnapshotError } from "./ecs/snapshot";
import { CommandBuffer, World as EcsWorld } from "./ecs/world";
import { EventBus } from "./Event";
import * as Plugin from "./Plugin";
import * as Save from "./Save";
import { Commands, Events, Random, Script, Time, World } from "./Services";
import type { BuiltIn, TimeState } from "./Services";
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
  /** Runs one tick. Throws if a system fails, or if the app has stopped. */
  readonly tick: (delta: number) => void;
  /**
   * As `dispatch`, for actions that arrive as data: network messages, saved
   * games, replays. The payload is expected in its JSON form and is validated
   * against the action's schema; an unknown name or a bad payload is a
   * failure, never a crash.
   */
  readonly dispatchByName: (
    name: string,
    payload: unknown
  ) => Exit.Exit<unknown, unknown>;
  /** As `enqueue`, for actions that arrive as data. Problems become `Action.Rejected` events. */
  readonly enqueueByName: (name: string, payload: unknown) => void;
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
   * time, the actions waiting for the next tick and the events waiting to
   * be read. Only between ticks.
   *
   * Fails with `SaveRefused`, which says what is in the way: an action or an
   * event with no schema is waiting, a field holds a value it cannot save,
   * or commands are queued and not applied.
   */
  readonly save: () => Exit.Exit<Save.Save, Save.SaveRefused>;
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
export interface App<E = never, R = never, HU = never> extends Any {
  /**
   * Runs one tick and returns the outcome, with system failures as a typed
   * `Exit`. An app that has stopped on a failed script runs nothing and
   * returns a defect, `ScriptFailed`.
   */
  readonly tickExit: (delta: number) => Exit.Exit<void, E>;
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
   * typed failure and leaves the game unchanged. Only between ticks.
   */
  readonly dispatch: <N extends ActionNames<HU>>(
    action: Action.ActionDef<N, PayloadFor<HU, N>, any>,
    payload: PayloadFor<HU, N>
  ) => Exit.Exit<ResultFor<HU, N>, FailureFor<HU, N>>;
  /**
   * Queues an action for the start of the next tick. Use this for real-time
   * input and from inside systems. A refusal becomes an `Action.Rejected` event.
   */
  readonly enqueue: <N extends ActionNames<HU>>(
    action: Action.ActionDef<N, PayloadFor<HU, N>, any>,
    payload: PayloadFor<HU, N>
  ) => void;
}

/** An error in a few words, for a log entry or a message. */
const describe = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

/**
 * A script failed in an app that was told to stop on one. It is the defect
 * every tick of that app fails with from then on.
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

export interface Options<
  S extends Systems = readonly [],
  H extends Handlers = readonly [],
  P extends Plugins = readonly [],
> {
  readonly plugins?: readonly [...P];
  /**
   * Components that belong to the app itself, not to a plugin. A world
   * knows a component by its name, so loading a save needs every component
   * the save names to be listed here or by a plugin.
   */
  readonly components?: readonly ComponentDef<any>[];
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
}

/** Starts a game afresh: every plugin's `setup` runs, then its scripts start. */
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
 * bytes are damaged.
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
    const spawn = <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<Fiber.Fiber<A, E>, never, R> =>
      Effect.map(Effect.forkDetach(effect), (fiber) => watch(fiber));

    // Dependencies first, each plugin once, then the app's own systems.
    const plugins = Plugin.flatten(options.plugins ?? []);
    const components = [
      ...plugins.flatMap((plugin) => plugin.components),
      ...(options.components ?? []),
    ];
    for (const component of components) {
      world.register(component);
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
    }[] = [];
    if (save !== undefined) {
      // In the JSON form they were saved in, checked again when applied.
      for (const { name, payload } of save.queued) {
        queued.push({ name, payload, encoded: true, entry: undefined });
      }
    }
    const actionLog: Action.LogEntry[] = [];
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
    const arrived = (name: string, payload: unknown) => {
      start();
      const entry: {
        readonly tick: number;
        readonly name: string;
        readonly payload: unknown;
        readonly queued: true;
        refused?: string;
      } = { tick: time.tick, name, payload, queued: true };
      actionLog.push(entry);
      return entry;
    };
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
      const json =
        codec === undefined
          ? Exit.succeed(payload)
          : Schema.encodeUnknownExit(codec)(payload);
      queued.push({
        name: action.name,
        payload,
        encoded: false,
        entry: Exit.isSuccess(json)
          ? arrived(action.name, json.value)
          : undefined,
      });
    };
    const enqueueByName = (name: string, payload: unknown): void => {
      queued.push({
        name,
        payload,
        encoded: true,
        entry: arrived(name, payload),
      });
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
      queued.push({
        name: action.name,
        payload,
        encoded: false,
        entry: undefined,
      });
    };

    const builtIns = Context.empty().pipe(
      Context.add(World, world),
      Context.add(Time, time),
      Context.add(Commands, commands),
      Context.add(Script, { nextTick, sleep, spawn }),
      Context.add(Events, events),
      Context.add(Action.Actions, { enqueue: enqueueFromInside }),
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

    const ordered = System.order(allSystems);
    let running = "";
    const tickEffect = Effect.gen(function* () {
      for (const system of ordered) {
        running = system.name;
        // Each system reads events from its own position.
        events.reader = running;
        yield* system.run;
        commands.apply();
      }
    });

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
     * to components, the random numbers it drew, and what it queued, emitted
     * and enqueued. With `dispatched`, an accepted action is logged; an
     * enqueued one was logged, if it came from outside, when it arrived.
     */
    const apply = (
      name: string,
      payload: unknown,
      encoded: boolean,
      dispatched: boolean
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
      let fiber: Fiber.Fiber<unknown, unknown>;
      try {
        fiber = runFork(handler.handle(value));
      } finally {
        events.reader = undefined;
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
        commands.apply();
        if (dispatched) {
          actionLog.push({ tick: time.tick, name, payload: logged });
        }
      }
      return exit;
    };

    const assertBetweenTicks = (name: string): void => {
      if (ticking) {
        throw new Error(
          `dispatch("${name}") was called during a tick. Use enqueue from systems and scripts.`
        );
      }
    };

    const tickExit = (delta: number): Exit.Exit<void, TickError<S, P>> => {
      if (ticking) {
        throw new Error("App.tick was called from inside a tick");
      }
      if (stopped !== undefined) {
        return Exit.die(stopped);
      }
      start();
      ticking = true;
      try {
        // Queued actions are applied before time advances, so they land at the
        // same point in the timeline as an action dispatched between ticks.
        if (queued.length > 0) {
          const batch = queued.splice(0);
          for (const { encoded, entry, name, payload } of batch) {
            const exit = apply(name, payload, encoded, false);
            if (Exit.isFailure(exit)) {
              const error = Cause.squash(exit.cause);
              if (entry !== undefined) {
                entry.refused = describe(error);
              }
              events.emit(Action.Rejected, { action: name, payload, error });
            }
          }
        }

        time.delta = delta;
        time.elapsed += delta;
        time.tick++;

        events.beginTick();
        const fiber = runFork(tickEffect);
        events.reader = undefined;
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
      actionLog,
      save() {
        if (ticking) {
          throw new Error(
            "save() was called during a tick. A game is saved between ticks."
          );
        }
        const refused = (message: string): Exit.Exit<never, Save.SaveRefused> =>
          Exit.fail(new Save.SaveRefused({ message }));
        if (commands.size > 0) {
          return refused(
            `${commands.size} commands are queued and not applied. They are applied at the end of a tick: save after one.`
          );
        }
        const waiting: { name: string; payload: unknown }[] = [];
        for (const { encoded, name, payload } of queued) {
          if (encoded) {
            waiting.push({ name, payload });
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
          waiting.push({ name, payload: json.value });
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
          logLength: actionLog.length,
        });
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
      tick(delta) {
        const exit = tickExit(delta);
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
        return apply(action.name, payload, false, true) as Exit.Exit<any, any>;
      },
      enqueue,
      dispatchByName(name, payload) {
        assertBetweenTicks(name);
        return apply(name, payload, true, true);
      },
      enqueueByName,
    };

    // Each plugin's setup runs once, in the same order, with everything in
    // place. Not when loading: the save holds what setup made.
    for (const plugin of plugins) {
      if (plugin.setup === undefined || save !== undefined) {
        continue;
      }
      events.reader = `setup:${plugin.name}`;
      const fiber = runFork(plugin.setup);
      events.reader = undefined;
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

/** A replayed log did not behave as it did when it was recorded. */
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
        app.enqueueByName(entry.name, entry.payload);
        waiting.push({
          index: next,
          entry,
          mine: app.actionLog.at(-1) as Action.Logged,
        });
      } else {
        const exit = app.dispatchByName(entry.name, entry.payload);
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
    app.tick(options.delta);
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
