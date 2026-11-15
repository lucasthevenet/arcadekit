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
 */
import { Cause, Context, Data, Effect, Exit, Layer, Schema } from "effect";
import type { Fiber, Scope } from "effect";
import * as Scheduler from "effect/Scheduler";

import * as Action from "./Action";
import { CommandBuffer, World as EcsWorld } from "./ecs/world";
import { EventBus } from "./Event";
import * as Plugin from "./Plugin";
import { Commands, Events, Script, Time, World } from "./Services";
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
  /** Runs one tick. Throws if a system fails. */
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
  /** Every action applied so far, in order. Enough to replay the game. */
  readonly actionLog: readonly Action.Logged[];
}

/**
 * @param E  what a tick can fail with
 * @param R  services available to scripts, beyond the built-in ones
 * @param HU a union of the app's action handlers
 */
export interface App<E = never, R = never, HU = never> extends Any {
  /** Runs one tick and returns the outcome, with system failures as a typed `Exit`. */
  readonly tickExit: (delta: number) => Exit.Exit<void, E>;
  /**
   * Starts a long-running fiber (a coroutine). It runs immediately up to its
   * first wait, and from then on only advances during ticks.
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

export const make = <
  S extends Systems = readonly [],
  H extends Handlers = readonly [],
  P extends Plugins = readonly [],
>(options: {
  readonly plugins?: readonly [...P];
  /** Systems and handlers that belong to the app itself, not to a plugin. */
  readonly systems?: readonly [...S];
  readonly handlers?: readonly [...H];
}): Effect.Effect<
  App<TickError<S, P>, Provided<P> | External<S, H, P>, AllHandlers<H, P>>,
  Plugin.ErrorOf<P[number]>,
  Scope.Scope | External<S, H, P>
> =>
  Effect.gen(function* () {
    const world = new EcsWorld();
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

    // Dependencies first, each plugin once, then the app's own systems.
    const plugins = Plugin.flatten(options.plugins ?? []);
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
    // from outside, or the value a handler works with.
    const queued: {
      readonly name: string;
      readonly payload: unknown;
      readonly encoded: boolean;
    }[] = [];
    const actionLog: Action.Logged[] = [];
    const enqueue = (
      action: Action.ActionDef<string, any, any>,
      payload: unknown
    ): void => {
      if (!handlers.has(action.name)) {
        throw new Error(`No handler for action "${action.name}"`);
      }
      queued.push({ name: action.name, payload, encoded: false });
    };
    const enqueueByName = (name: string, payload: unknown): void => {
      queued.push({ name, payload, encoded: true });
    };

    const builtIns = Context.empty().pipe(
      Context.add(World, world),
      Context.add(Time, time),
      Context.add(Commands, commands),
      Context.add(Script, { nextTick, sleep }),
      Context.add(Events, events),
      Context.add(Action.Actions, { enqueue })
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

    const scripts = new Set<Fiber.Fiber<any, any>>();
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

    /**
     * Validates a payload, runs its handler to completion, and logs the action
     * if it was accepted. A refusal undoes what the handler queued.
     */
    const apply = (
      name: string,
      payload: unknown,
      encoded: boolean
    ): Exit.Exit<unknown, unknown> => {
      const handler = handlers.get(name);
      if (handler === undefined) {
        return Exit.fail(new Action.UnknownAction({ action: name }));
      }

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

      const commandMark = commands.mark();
      const eventMark = events.mark();
      events.reader = `action:${name}`;
      const fiber = runFork(handler.handle(value));
      events.reader = undefined;
      const exit = fiber.pollUnsafe();
      if (exit === undefined) {
        fiber.interruptUnsafe();
        commands.rollback(commandMark);
        events.rollback(eventMark);
        throw new Error(
          `The handler for "${name}" did not finish synchronously. Handlers must not wait.`
        );
      }
      if (Exit.isFailure(exit)) {
        commands.rollback(commandMark);
        events.rollback(eventMark);
      } else {
        commands.apply();
        actionLog.push({ tick: time.tick, name, payload: logged });
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
      ticking = true;
      try {
        // Queued actions are applied before time advances, so they land at the
        // same point in the timeline as an action dispatched between ticks.
        if (queued.length > 0) {
          const batch = queued.splice(0);
          for (const { encoded, name, payload } of batch) {
            const exit = apply(name, payload, encoded);
            if (Exit.isFailure(exit)) {
              events.emit(Action.Rejected, {
                action: name,
                payload,
                error: Cause.squash(exit.cause),
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
        const exit = fiber.pollUnsafe();
        if (exit === undefined) {
          fiber.interruptUnsafe();
          dispatcher.flush();
          throw new Error(
            `System "${running}" did not finish within the tick. Systems must be synchronous; ` +
              `start long-running work with app.spawnScript or Effect.forkDetach.`
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
      tickExit,
      tick(delta) {
        const exit = tickExit(delta);
        if (Exit.isFailure(exit)) {
          throw Cause.squash(exit.cause);
        }
      },
      spawnScript(effect) {
        const fiber = runFork(effect as Effect.Effect<any, any, any>);
        if (fiber.pollUnsafe() === undefined) {
          scripts.add(fiber);
          fiber.addObserver(() => scripts.delete(fiber));
        }
        return fiber;
      },
      dispatch(action, payload) {
        assertBetweenTicks(action.name);
        // A typed dispatch of an action nobody handles is a programming error.
        if (!handlers.has(action.name)) {
          throw new Error(`No handler for action "${action.name}"`);
        }
        return apply(action.name, payload, false) as Exit.Exit<any, any>;
      },
      enqueue,
      dispatchByName(name, payload) {
        assertBetweenTicks(name);
        return apply(name, payload, true);
      },
      enqueueByName,
    };

    // Each plugin's setup runs once, in the same order, with everything in place.
    for (const plugin of plugins) {
      if (plugin.setup === undefined) {
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
    return app;
  }) as Effect.Effect<
    App<TickError<S, P>, Provided<P> | External<S, H, P>, AllHandlers<H, P>>,
    Plugin.ErrorOf<P[number]>,
    Scope.Scope | External<S, H, P>
  >;

/** A replayed log did not behave as it did when it was recorded. */
export class ReplayDiverged extends Data.TaggedError("ReplayDiverged")<{
  /** Position in the log of the entry that was refused. */
  readonly index: number;
  readonly entry: Action.Logged;
  readonly reason: unknown;
}> {
  override get message(): string {
    const reason =
      this.reason instanceof Error
        ? this.reason.message || this.reason.name
        : String(this.reason);
    return `Log entry ${this.index} ("${this.entry.name}" at tick ${this.entry.tick}) was refused on replay: ${reason}`;
  }
}

/**
 * Re-applies a recorded action log to a fresh app, ticking with a fixed
 * delta. With the same systems and the same starting state, the result is
 * the same game.
 *
 * The log only ever holds actions that were accepted, so an entry that is
 * refused now means the log was altered or the game has changed since. The
 * replay stops there and throws `ReplayDiverged`.
 */
export const replay = (
  app: Any,
  log: readonly Action.Logged[],
  options: { readonly delta: number; readonly ticks: number }
): void => {
  let next = 0;
  const applyDue = (): void => {
    for (
      let entry = log[next];
      entry !== undefined && entry.tick === app.time.tick;
      entry = log[next]
    ) {
      const exit = app.dispatchByName(entry.name, entry.payload);
      if (Exit.isFailure(exit)) {
        throw new ReplayDiverged({
          index: next,
          entry,
          reason: Cause.squash(exit.cause),
        });
      }
      next++;
    }
  };
  for (let i = 0; i < options.ticks; i++) {
    applyDue();
    app.tick(options.delta);
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
