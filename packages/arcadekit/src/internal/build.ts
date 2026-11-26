/**
 * Builds an app from a game and how one run of it starts. It makes the app's
 * world and the stores the world holds for it, loads the save the run
 * continues from, and makes the app's services, runner, inbox and loop.
 * `App.make` makes its app here.
 */
import { Context, Effect, Exit, Layer, Metric, Scope } from "effect";
import * as Scheduler from "effect/Scheduler";

import * as Action from "../Action.ts";
import type {
  AllHandlers,
  App,
  External,
  Game,
  Handlers,
  Plugins,
  StartOptions,
  Systems,
  TickError,
} from "../App.ts";
import { CommandBuffer } from "../ecs/commands.ts";
import type { Spawned } from "../ecs/spawned.ts";
import { World as EcsWorld } from "../ecs/world.ts";
import * as Input from "../Input.ts";
import type { Migration } from "../Migrate.ts";
import * as Plugin from "../Plugin.ts";
import * as Save from "../Save.ts";
import { Time, World } from "../Services.ts";
import type { TimeState } from "../Services.ts";
import { EventBus } from "./eventBus.ts";
import { reading } from "./handed.ts";
import * as Inbox from "./inbox.ts";
import { Undrawn } from "./input.ts";
import { Intake } from "./intake.ts";
import { Log } from "./log.ts";
import * as Loop from "./loop.ts";
import { hold, moved } from "./parts.ts";
import type { Parts } from "./parts.ts";
import { flatten } from "./plugins.ts";
import * as Runner from "./runner.ts";
import { Visits, into, takeSave } from "./save.ts";
import * as Schedule from "./schedule.ts";
import * as Stage from "./stage.ts";
import { prepare, refuseRemovedScopes } from "./state.ts";
import { TickDispatcher, TickScheduler } from "./tickScheduler.ts";

/**
 * What the code that took over an app holds: the two operations the app no
 * longer performs for anyone else.
 *
 * @category Models
 */
export interface Reins<E = never> {
  /**
   * Queues an action for the next tick and logs it, as `app.enqueueByName`
   * does on an app nobody has taken over. It takes the action by name, with
   * its payload in JSON form, and with its issuer.
   */
  readonly deliver: (name: string, payload: unknown, from?: string) => void;
  /**
   * Runs one tick, as `app.tick` does on an app nobody has taken over.
   * `observe` is called with undefined before the tick's systems run, and
   * with each system's name once that system has run and its commands are
   * applied.
   */
  readonly tick: (
    delta: number,
    observe?: (system: string | undefined) => void
  ) => Effect.Effect<void, E>;
}

/**
 * An app as it is built, with the way to take it over. `App.make` returns its
 * `app`, and a session takes it over with `take`.
 *
 * @category Models
 */
export interface Built<E = never, HU = never> {
  readonly app: App<E, HU>;
  /**
   * Takes over the app, for code that decides on which tick an action is
   * applied and when a tick runs. A session does, since every peer must apply
   * the same actions on the same ticks.
   *
   * From then on, an action enqueued from outside isn't queued for the next
   * tick. It is passed to `issued`, by name and with its payload in JSON
   * form. `issued` gets every action given to `enqueue` or `enqueueByName`,
   * and every action issued with `Actions.enqueue` in the input or frame
   * stage, such as from key bindings and UI buttons. What the simulation
   * issues itself isn't passed on, since every peer's simulation issues it.
   *
   * The reins are the only remaining way to queue an action and to run a
   * tick. The app's `tick`, `dispatch` and `dispatchByName` die from then
   * on, since each would advance this machine's game and no one else's.
   * Taking an app over a second time throws.
   */
  readonly take: (issued: (name: string, payload: unknown) => void) => Reins<E>;
}

/**
 * Makes the app of a game, from a seed or from a save, with the way to take it
 * over. The app has a scope of its own, which its `close` closes. When the
 * making fails, that scope is closed at once. It fails with what a plugin's
 * setup fails with, and with `Save.LoadRefused` only when it is given a save.
 * It throws when it is given both a save and a seed.
 *
 * @category Constructors
 */
export const build = <
  S extends Systems,
  H extends Handlers,
  P extends Plugins,
  SV extends Save.Save | undefined = undefined,
>(
  game: Game<S, H, P>,
  start: StartOptions<SV>
): Effect.Effect<
  Built<TickError<S, P>, AllHandlers<H, P>>,
  Plugin.ErrorOf<P[number]> | (SV extends Save.Save ? Save.LoadRefused : never),
  External<S, H, P>
> =>
  Effect.suspend(() => {
    const scope = Scope.makeUnsafe();
    return Effect.onError(assemble(game, start, scope), (cause) =>
      Scope.close(scope, Exit.failCause(cause))
    );
  });

/**
 * Attaches to a world the stores an app keeps in its world, before the world
 * loads a save, which may hold some of each. The app's log is attached later,
 * since it saves nothing.
 */
const storesOf = (world: EcsWorld) => {
  const events = new EventBus(world);
  const intake = new Intake();
  world._attach(intake);
  world._attach(
    new Visits(world, (reader) => !reader.startsWith(Stage.READER))
  );
  return { events, intake };
};

/**
 * Loads a save into a world of its own, with the stores of an app's world,
 * as the app's world would load it: what `app.load` tries before it puts its
 * own world back to the save, so that a save it refuses leaves the app as it
 * was. It returns the save as it was loaded, brought up to `version`.
 */
const tried = (
  save: Save.Save,
  version: number,
  migrations: readonly Migration[]
): Exit.Exit<Save.Save, Save.LoadRefused> => {
  const world = new EcsWorld();
  storesOf(world);
  const loaded = into(world, save, version, migrations);
  if (Exit.isFailure(loaded)) {
    return loaded;
  }
  return Exit.map(refuseRemovedScopes(world), () => loaded.value);
};

/** Puts an app together in `scope`, which is the app's. */
const assemble = <
  S extends Systems,
  H extends Handlers,
  P extends Plugins,
  SV extends Save.Save | undefined = undefined,
>(
  game: Game<S, H, P>,
  start: StartOptions<SV>,
  scope: Scope.Closeable
): Effect.Effect<
  Built<TickError<S, P>, AllHandlers<H, P>>,
  Plugin.ErrorOf<P[number]> | (SV extends Save.Save ? Save.LoadRefused : never),
  External<S, H, P>
> =>
  Effect.gen(function* () {
    const { save: given, seed } = start;
    if (given !== undefined && seed !== undefined) {
      throw new Error(
        `App.make was given a save and the seed ${seed}. A save holds where its game's random sequence had got to: give one of the two.`
      );
    }
    const world = new EcsWorld(seed === undefined ? undefined : { seed });
    world._checkReads = start.verifyFrames === true;
    const commands = new CommandBuffer<Spawned>(world);
    const { events, intake } = storesOf(world);
    const dispatcher = new TickDispatcher();
    const scheduler = new TickScheduler(dispatcher);

    // Dependencies first, each plugin once, then the app's own systems.
    const plugins = flatten(game.plugins);
    const { version } = game;
    let save: Save.Save | undefined;
    if (given !== undefined) {
      // Before anything else can touch the world: a load fills an empty one.
      const loaded = into(world, given, version, game.migrations);
      if (Exit.isFailure(loaded)) {
        return yield* loaded;
      }
      const scoped = refuseRemovedScopes(world);
      if (Exit.isFailure(scoped)) {
        return yield* scoped;
      }
      save = loaded.value;
    }
    // Loaded with the world, or written by the first tick.
    const time: TimeState = world.singleton(Stage.GameTime);
    const allSystems = [
      ...plugins.flatMap((plugin) => plugin.systems),
      ...game.systems,
    ];
    const allHandlers = [
      ...plugins.flatMap((plugin) => plugin.handlers),
      ...game.handlers,
    ];

    const handlers = Inbox.handlersOf(allHandlers);
    const log = new Log(
      world,
      time,
      start.hashEvery ?? 60,
      save === undefined ? { seed: seed ?? 0 } : { save }
    );
    world._attach(log);
    // What systems and handlers issue goes through the inbox, made below
    // once the app's services are built.
    const actions: Context.Service.Shape<typeof Action.Actions> = {
      enqueue: (action, ...payload) => {
        inbox.issue(action, payload[0]);
      },
      handles: (action) => inbox.handles(action),
    };
    const builtIns = Stage.tick({
      world,
      time,
      commands,
      events,
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
    const built = yield* Layer.buildWithScope(layer, scope);
    // Everything the caller provided (their services, resource overrides) is
    // captured once here and handed to every system and handler, with the
    // app's own scope in place of any the caller had.
    const provided = (yield* Effect.context<External<S, H, P>>()).pipe(
      Context.add(Scope.Scope, scope)
    );
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
    // In the app's scope, wherever its layer was provided: the devices are
    // heard until the app is closed.
    const listener = yield* Scope.provide(
      Context.get(context, Input.Source).listen,
      scope
    );

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
    // What the frame and input stages keep, let go of with the app.
    const locals = new Stage.LocalStore();
    // Which ticks the frame stage has drawn, which a rewind moves back.
    const undrawn = new Undrawn(time.tick);
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => locals.release())
    );
    // What runs between ticks hears the events of every tick, the first
    // among them: they are kept for it from the start.
    if (schedule.frame.length > 0) {
      events.expect("frame", time.tick);
    }
    if (schedule.input.length > 0) {
      events.expect("input", time.tick);
    }
    prepare(world, schedule.hooked, save !== undefined);

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
      listener,
      actions,
      seed: seed ?? 0,
      locals,
      undrawn,
      verifyFrames: start.verifyFrames === true,
    });
    // What a run ends with is what the game's systems fail with: the loop
    // runs them as systems of any game, and their types are claimed back. A
    // call where it may not be throws, and the Effect dies with it.
    type Ran = Exit.Exit<void, TickError<S, P>>;
    const frame = (
      alpha = 1,
      delta?: number
    ): Effect.Effect<void, TickError<S, P>> =>
      Effect.suspend(() => loop.frame(alpha, delta) as Ran);
    const input = (): Effect.Effect<void, TickError<S, P>> =>
      Effect.suspend(() => loop.input() as Ran);
    const after: Parts["after"] = new Set();
    // Where in the log each save this app made, or started from, was taken,
    // for a recording since it.
    const made = new WeakMap<Save.Save, number>();
    if (given !== undefined && save !== undefined) {
      made.set(given, 0);
      made.set(save, 0);
    }
    const parts: Parts = {
      world,
      commands,
      events,
      dispatcher,
      log,
      after,
      undrawn,
      locals,
      save: () =>
        Effect.suspend(() => {
          runner.whileIdle(
            (busy) =>
              `Save.make() was called during a ${busy}. A game is saved between ticks.`
          );
          return Exit.map(takeSave(world, commands, version), (taken) => {
            made.set(taken, log.entries.length);
            return taken;
          });
        }),
      load: (loading) =>
        Effect.suspend((): Effect.Effect<void, Save.LoadRefused> => {
          runner.whileIdle(
            (busy) =>
              `Save.load() was called during a ${busy}. A save is loaded between ticks.`
          );
          if (inbox.diverted !== undefined) {
            throw new Error(
              "Save.load() was called on an app that a session has taken over. It would put this machine's game where the other peers' are not. A session's peers start from one save together: make each peer's app from it with App.make(game, { save })."
            );
          }
          const loaded = tried(loading, version, game.migrations);
          if (Exit.isFailure(loaded)) {
            return loaded;
          }
          // The save loads: from here on nothing fails, and the app is the
          // one App.make would make from it, with its own layers and stages.
          dispatcher.flush();
          commands.rollback(0);
          world.restore(loaded.value.world);
          prepare(world, schedule.hooked, true);
          events.restarted(time.tick);
          undrawn.restarted(time.tick);
          log.restart(loaded.value);
          made.set(loading, 0);
          made.set(loaded.value, 0);
          return then(Exit.void);
        }),
      record: (since) =>
        Effect.sync(() => {
          runner.whileIdle(
            (busy) =>
              `Replay.record() was called during a ${busy}. A game is recorded between ticks.`
          );
          if (since === undefined) {
            return log.record(undefined);
          }
          const at = made.get(since);
          if (at === undefined) {
            throw new Error(
              "Replay.record() was given a save that this app didn't make, or didn't start from: its log doesn't say where the save is in it. Record since a save of this app, as Save.make made it, or record all of it."
            );
          }
          return log.record({ save: since, logLength: at });
        }),
      hashCheck: () =>
        Effect.sync(() => {
          runner.whileIdle(
            (busy) =>
              `Replay.hashCheck() was called during a ${busy}. A hash check is taken between ticks, where a replay can compare it.`
          );
          return log.hashCheck();
        }),
    };
    /** What ran, then what code outside the game has the app do once it has. */
    const then = <A, E>(ran: Exit.Exit<A, E>): Effect.Effect<A, E> =>
      after.size === 0 || Exit.isFailure(ran)
        ? ran
        : Effect.as(moved(parts), ran.value);
    const tick = (delta: number): Effect.Effect<void, TickError<S, P>> =>
      Effect.suspend(() => {
        if (inbox.diverted !== undefined) {
          throw new Error(
            "App.tick was called on an app that a session has taken over. It would move this machine's game a tick ahead of the other peers'. The session steps the app: call the session's tick, or give the session to the driver."
          );
        }
        return then(loop.tick(delta) as Ran);
      });

    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => dispatcher.flush())
    );

    const read = Context.make(World, reading(world)).pipe(
      Context.add(Time, time)
    );
    const app: App<TickError<S, P>, AllHandlers<H, P>> = {
      time,
      read: (effect) =>
        Effect.suspend(() => {
          runner.whileIdle(
            (busy) =>
              `app.read() was run during a ${busy}. A game is read from outside it between ticks.`
          );
          // `Readable` holds the requirements to what `read` provides.
          return Effect.provideContext(
            effect as Effect.Effect<
              Effect.Success<typeof effect>,
              Effect.Error<typeof effect>,
              World | Time
            >,
            read
          );
        }),
      plugins: plugins.map((plugin) => plugin.name),
      systemOrder: schedule.tick.map((turn) => turn.system.name),
      get phase() {
        return runner.phase;
      },
      frameOrder: schedule.frame.map((turn) => turn.system.name),
      inputOrder: schedule.input.map((turn) => turn.system.name),
      actionLog: log.entries,
      get settled() {
        return loop.settled();
      },
      inspect: () =>
        Effect.sync(() => {
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
        }),
      close: Scope.close(scope, Exit.void),
      tick,
      frame,
      input,
      dispatch: (action, ...payload) =>
        // What the action's handler returns or fails with.
        Effect.suspend(() =>
          then(inbox.dispatch(action, payload[0]) as Exit.Exit<never, never>)
        ),
      enqueue: (action, ...payload) =>
        Effect.suspend(() => inbox.enqueue(action, payload[0])),
      dispatchByName: (name, payload, from) =>
        // What the action's handler fails with, or why it was not applied.
        Effect.suspend(() =>
          then(
            inbox.dispatchByName(name, payload, from) as Exit.Exit<
              unknown,
              never
            >
          )
        ),
      enqueueByName: (name, payload, from) =>
        Effect.sync(() => {
          inbox.enqueueByName(name, payload, from);
        }),
    };
    hold(app, parts);
    const take: Built<TickError<S, P>>["take"] = (issued) => {
      if (inbox.diverted !== undefined) {
        throw new Error(
          "An app was taken over that has been taken over already. An app is in one session at a time."
        );
      }
      inbox.diverted = issued;
      return {
        deliver: (name, payload, from) => {
          inbox.deliver(name, payload, from);
        },
        tick: (delta, observe) =>
          Effect.suspend(() => loop.tick(delta, observe) as Ran),
      };
    };

    // Each plugin's setup runs once, in the same order, with everything in
    // place. Not when loading: the save holds what setup made.
    for (const { name, setup } of save === undefined ? plugins : []) {
      if (setup !== undefined) {
        const ran = loop.setup(name, setup);
        if (Exit.isFailure(ran)) {
          return yield* ran as Exit.Exit<never, Plugin.ErrorOf<P[number]>>;
        }
      }
    }
    commands.apply();
    // What the setups emitted is of the tick to come.
    events.told(time.tick + 1);
    return { app, take };
  }) as Effect.Effect<
    Built<TickError<S, P>, AllHandlers<H, P>>,
    | Plugin.ErrorOf<P[number]>
    | (SV extends Save.Save ? Save.LoadRefused : never),
    External<S, H, P>
  >;
