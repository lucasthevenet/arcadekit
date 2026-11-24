/**
 * Builds an app from a game and how one run of it starts. It makes the app's
 * world and the stores the world holds for it, loads the save the run
 * continues from, and makes the app's services, runner, inbox and loop.
 * `App.make` makes its app here.
 */
import { Cause, Context, Effect, Exit, Layer, Metric, Scope } from "effect";
import * as Scheduler from "effect/Scheduler";

import * as Action from "../../Action";
import { CommandBuffer } from "../../ecs/commands";
import type { Spawned } from "../../ecs/spawned";
import { World as EcsWorld } from "../../ecs/world";
import { EventBus } from "../../event/Event";
import * as Input from "../../Input";
import * as Journal from "../../Journal";
import * as Plugin from "../../Plugin";
import * as Save from "../../Save";
import { Time, World } from "../../Services";
import type { TimeState } from "../../Services";
import { reading } from "../../services/handed";
import * as State from "../../State";
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
} from "../App";
import * as Inbox from "./inbox";
import * as Loop from "./loop";
import { hold } from "./parts";
import * as Runner from "./runner";
import * as Schedule from "./schedule";
import * as Stage from "./stage";
import { TickDispatcher, TickScheduler } from "./tick-scheduler";

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
   * Runs one tick, as `app.tickExit` does on an app nobody has taken over.
   * `observe` is called with undefined before the tick's systems run, and
   * with each system's name once that system has run and its commands are
   * applied.
   */
  readonly tickExit: (
    delta: number,
    observe?: (system: string | undefined) => void
  ) => Exit.Exit<void, E>;
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
   * tick. The app's `tick`, `tickExit`, `dispatch` and `dispatchByName` throw
   * from then on, since each would advance this machine's game and no one
   * else's. Taking an app over a second time throws.
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
    const plugins = Plugin.flatten(game.plugins);
    const { version } = game;
    let save: Save.Save | undefined;
    if (given !== undefined) {
      // Before anything else can touch the world: a load fills an empty one.
      const loaded = Save.into(world, given, version, game.migrations);
      if (Exit.isFailure(loaded)) {
        return yield* loaded;
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
    const log = new Journal.Log(
      world,
      time,
      start.checkpointEvery ?? 60,
      save === undefined ? { seed: seed ?? 0 } : { save }
    );
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
    // What runs between ticks hears the events of every tick, the first
    // among them: they are kept for it from the start.
    if (schedule.frame.length > 0) {
      events.expect("frame", time.tick);
    }
    if (schedule.input.length > 0) {
      events.expect("input", time.tick);
    }
    State.prepare(world, schedule.hooked, save !== undefined);

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
      verifyFrames: start.verifyFrames === true,
    });
    // What a run ends with is what the game's systems fail with: the loop
    // runs them as systems of any game, and their types are claimed back.
    type Ran = Exit.Exit<void, TickError<S, P>>;
    const orThrow = (exit: Ran): void => {
      if (Exit.isFailure(exit)) {
        throw Cause.squash(exit.cause);
      }
    };
    const frameExit = (alpha = 1, delta?: number): Ran =>
      loop.frame(alpha, delta) as Ran;
    const inputExit = (): Ran => loop.input() as Ran;
    const tickExit = (delta: number): Ran => {
      if (inbox.diverted !== undefined) {
        throw new Error(
          "App.tick was called on an app that a session has taken over. It would move this machine's game a tick ahead of the other peers'. The session steps the app: call the session's tick, or give the session to the driver."
        );
      }
      return loop.tick(delta) as Ran;
    };

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
      record(since) {
        runner.whileIdle(
          (busy) =>
            `record() was called during a ${busy}. A game is recorded between ticks.`
        );
        return log.record(since);
      },
      save() {
        runner.whileIdle(
          (busy) =>
            `save() was called during a ${busy}. A game is saved between ticks.`
        );
        return Save.take(world, commands, version, log.entries.length);
      },
      get settled() {
        return loop.settled();
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
      close: Scope.close(scope, Exit.void),
      tickExit,
      tick: (delta) => {
        orThrow(tickExit(delta));
      },
      frameExit,
      frame: (alpha, delta) => {
        orThrow(frameExit(alpha, delta));
      },
      inputExit,
      input: () => {
        orThrow(inputExit());
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
    };
    hold(app, { world, commands, events, dispatcher });
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
        tickExit: (delta, observe) => loop.tick(delta, observe) as Ran,
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
