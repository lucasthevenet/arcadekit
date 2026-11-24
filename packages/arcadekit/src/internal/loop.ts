/**
 * An app's loop runs its stages. A tick applies the actions queued for it,
 * moves time on, and gives each system its turn. The frame stage and the input
 * stage run between two ticks, with the world frozen. `Stage` says what the
 * systems of each stage are given.
 */
import {
  Clock,
  Context,
  Effect,
  Exit,
  LogLevel,
  References,
  Tracer,
} from "effect";

import type * as Action from "../Action";
import { FrameChangedWorld } from "../App";
import type { CommandBuffer } from "../ecs/commands";
import type { Spawned } from "../ecs/spawned";
import type { World as EcsWorld } from "../ecs/world";
import type { EventBus } from "../Event";
import * as Input from "../Input";
import type * as Journal from "../Journal";
import type { FrameState, TimeState } from "../Services";
import * as State from "../State";
import * as System from "../System";
import type { Inbox } from "./inbox";
import type { Runner } from "./runner";
import type * as Schedule from "./schedule";
import * as Stage from "./stage";

/**
 * The spans of an app that traces. A tick's span is opened before the tick
 * applies its actions, each in a fiber of its own, so that the actions' spans
 * and the systems' spans are its children.
 *
 * @category Models
 */
export class Spans {
  /**
   * Whether the app traces, chosen once, so an app that doesn't trace runs no
   * tracing code. An app traces when a tracer other than Effect's default is
   * provided, tracing is enabled, and `Tracer.MinimumTraceLevel` lets "Debug"
   * spans through.
   */
  readonly enabled: boolean;
  /** The span of the tick that is running, in an app that traces. */
  tick: Tracer.Span | undefined;
  private readonly context: Context.Context<unknown>;

  /** `context` is what the tick's code runs with. */
  constructor(context: Context.Context<unknown>) {
    this.context = context;
    this.enabled =
      Context.get(context, Tracer.Tracer) !== Tracer.nativeTracer &&
      Context.get(context, References.TracerEnabled) &&
      !LogLevel.isGreaterThan(
        Context.get(context, Tracer.MinimumTraceLevel),
        System.spanLevel
      );
  }

  /** Opens a span that has no parent. */
  open(name: string, attributes: Record<string, unknown>): Tracer.Span {
    const made = Effect.runForkWith(this.context)(
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
  }

  /** Ends a span that `open` made, with the exit of what it covers. */
  end(span: Tracer.Span, exit: Exit.Exit<unknown, unknown>): void {
    const { context } = this;
    span.end(
      Context.get(context, References.TracerTimingEnabled)
        ? Context.get(context, Clock.Clock).currentTimeNanosUnsafe()
        : 0n,
      exit
    );
  }

  /**
   * Returns what an action's handler returned, in a span of its own when the
   * app traces. For an action that a tick applies, the span is the tick's
   * child.
   */
  action<A, E, R>(
    name: string,
    handled: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> {
    if (!this.enabled) {
      return handled;
    }
    return Effect.withSpan(
      handled,
      `action:${name}`,
      this.tick === undefined
        ? { root: true, level: System.spanLevel }
        : { parent: this.tick, level: System.spanLevel }
    );
  }
}

/**
 * What a loop runs with: the parts of an app that a tick and the stages
 * between ticks touch.
 *
 * @category Models
 */
export interface Parts {
  readonly world: EcsWorld;
  readonly commands: CommandBuffer<Spawned>;
  readonly events: EventBus;
  /** What the game has taken in for its next tick, a store of the world. */
  readonly intake: Action.Intake;
  readonly log: Journal.Log;
  readonly inbox: Inbox;
  readonly runner: Runner;
  readonly time: TimeState;
  readonly schedule: Schedule.Schedule;
  readonly spans: Spans;
  /** What the tick's code runs with: the app's services and the game's own. */
  readonly context: Context.Context<unknown>;
  /** The devices, listened to until the app is closed. */
  readonly listener: Input.Listener;
  readonly actions: Stage.Actions;
  /** Where the frame stage's own random sequence starts. */
  readonly seed: number;
  /** Whether the stages between ticks are checked to leave the world as it was. */
  readonly verifyFrames: boolean;
}

/**
 * What runs an app's tick, its two stages between ticks and a plugin's setup,
 * and says whether the game has come to rest. Each run returns its exit. The
 * error is unknown here, and the app, which knows what the game's systems fail
 * with, gives it its type.
 *
 * @category Models
 */
export interface Loop {
  /**
   * Runs a tick. `observe` is called with undefined before the tick's first
   * system, and with each system's name once that system has run and its
   * commands are applied.
   */
  readonly tick: (
    delta: number,
    observe?: (system: string | undefined) => void
  ) => Exit.Exit<void, unknown>;
  /**
   * Runs the frame stage, for a frame `alpha` of the way to the next tick and
   * `delta` real seconds after the previous frame.
   */
  readonly frame: (alpha: number, delta?: number) => Exit.Exit<void, unknown>;
  /** Runs the input stage, with one sample of the devices. */
  readonly input: () => Exit.Exit<void, unknown>;
  /**
   * Runs a plugin's setup, as the game's own code between ticks, and applies
   * the commands it queued if it did not fail.
   */
  readonly setup: (
    plugin: string,
    setup: Effect.Effect<unknown, unknown, unknown>
  ) => Exit.Exit<unknown, unknown>;
  /**
   * Whether the game has come to rest, `app.settled`: its last tick changed
   * nothing but its time, no action was dispatched since, no action is
   * queued, no fiber waits, every event has been read and no state has a
   * move to make.
   */
  readonly settled: () => boolean;
}

/**
 * Makes the loop of an app from the app's parts.
 *
 * @category Constructors
 */
export const make = (parts: Parts): Loop => {
  const {
    commands,
    context,
    events,
    inbox,
    intake,
    log,
    runner,
    listener,
    schedule,
    spans,
    time,
    verifyFrames,
    world,
  } = parts;
  const trace = spans.enabled;
  const states = State.registryOf(world);
  // Whoever stepped the tick that is running, if they asked to be told.
  let observer: ((system: string | undefined) => void) | undefined;
  // What the world hashed to when the stage between ticks began.
  let frameHash = 0;
  const drawing: FrameState = { alpha: 0, delta: 0, count: 0 };

  /**
   * Gives each system of a list its turn, in order. Each runs as itself:
   * it reads the events, and what changed, from a place of its own, which
   * for a stage between ticks is apart from the simulation's and never
   * saved. In a tick, its commands are applied when it has run, and
   * `observed`, whoever stepped the tick is told. Between ticks there is
   * nothing to apply, and the world is checked to be as it was.
   *
   * A generator to delegate to, and not an Effect of its own for each
   * system, which measured a generator per system per tick. One reading of
   * the clock ends a turn and begins the next, which halves what timing
   * them costs.
   */
  const takeTurns = function* (
    turns: readonly Schedule.Turn[],
    stage: "tick" | "frame" | "input",
    observed: boolean
  ) {
    const inTick = stage === "tick";
    let clock = performance.now();
    for (const turn of turns) {
      const running = turn.system.name;
      runner.running = running;
      const reader = inTick ? running : `${Stage.READER}${running}`;
      events.reader = reader;
      world.reader = reader;
      turn.ran = true;
      // A system with no condition is asked nothing.
      if (turn.condition !== undefined && !(yield* turn.condition)) {
        turn.ran = false;
        // What it does in place of running, if it was given anything.
        if (turn.idle !== undefined) {
          yield* turn.idle;
        }
        // It sees nothing that changed while it was off, as no event.
        world.skip(reader);
      } else {
        yield* turn.run;
      }
      if (inTick) {
        commands.apply();
      }
      const now = performance.now();
      turn.ms = now - clock;
      clock = now;
      if (inTick) {
        if (observed && observer !== undefined) {
          observer(running);
          // What it does is not the next system's to pay for.
          clock = performance.now();
        }
      } else if (verifyFrames) {
        if (world._frameHash(true) !== frameHash) {
          return yield* Effect.die(
            new FrameChangedWorld({
              stage,
              system: running,
              frame: drawing.count,
            })
          );
        }
        // The hash is not the next system's to pay for.
        clock = performance.now();
      }
    }
  };
  /** Makes one state transition: the exit hooks, the transition, then the enter hooks. */
  const makeMove = Effect.fnUntraced(function* (
    state: State.State<string>,
    move: State.Move
  ) {
    if (move.from !== undefined) {
      yield* takeTurns(schedule.hooks(state, "exit", move.from), "tick", false);
    }
    State.despawnScoped(world, state, move);
    State.enter(world, state, move);
    yield* takeTurns(schedule.hooks(state, "enter", move.to), "tick", false);
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
  const ticking = Effect.gen(function* () {
    if (states.states.length > 0) {
      yield* enterStates;
    }
    observer?.(undefined);
    yield* takeTurns(schedule.tick, "tick", true);
  });
  const runTick = Effect.runForkWith(context);

  // The stages between ticks. The input stage is told what the devices say:
  // one picture of them, taken when the stage begins.
  const frameContext = Stage.frame(context, {
    world,
    time,
    frame: drawing,
    events,
    actions: parts.actions,
    seed: parts.seed,
  });
  const runFrame = Effect.runForkWith(frameContext);
  const devices: {
    -readonly [K in keyof Input.Sample]: Input.Sample[K];
  } = {
    down: new Set(),
    pressed: [],
    released: [],
    axes: new Map(),
    moved: [],
  };
  const runInput = Effect.runForkWith(Stage.input(frameContext, devices));
  const drawn = Effect.gen(() => takeTurns(schedule.frame, "frame", false));
  const heard = Effect.gen(() => takeTurns(schedule.input, "input", false));
  const drawnTraced = trace
    ? Effect.suspend(() =>
        Effect.withSpan(drawn, "arcadekit/frame", {
          root: true,
          attributes: { "arcadekit.frame": drawing.count },
          level: System.spanLevel,
        })
      )
    : drawn;
  const heardTraced = trace
    ? Effect.withSpan(heard, "arcadekit/input", {
        root: true,
        level: System.spanLevel,
      })
    : heard;

  /** Runs one of the two stages between ticks, with the world frozen. */
  const between = (stage: "frame" | "input"): Exit.Exit<void, unknown> => {
    runner.between = stage;
    events.stage = stage;
    world.freeze();
    let exit: Exit.Exit<void, unknown>;
    let drew: unknown;
    try {
      if (verifyFrames) {
        frameHash = world._frameHash(true);
      }
      runner.running = "";
      exit = runner.finish(
        () =>
          stage === "frame" ? runFrame(drawnTraced) : runInput(heardTraced),
        stage === "frame" ? "The frame" : "The input stage",
        () =>
          `System "${runner.running}" did not finish within the ${stage === "frame" ? "frame" : "input stage"}. Systems must be synchronous.`,
        true
      );
      // Its systems have had their chance at every event there is.
      events.ended(stage, time.tick);
    } finally {
      runner.between = undefined;
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

  const runFrameStage = (
    alpha: number,
    delta = 0
  ): Exit.Exit<void, unknown> => {
    runner.whileIdle(
      (busy) =>
        `App.frame was called from inside a ${busy}. The frame stage runs between ticks.`
    );
    if (schedule.frame.length === 0) {
      return Exit.void;
    }
    drawing.alpha = alpha;
    drawing.delta = delta;
    drawing.count++;
    return between("frame");
  };

  const runInputStage = (): Exit.Exit<void, unknown> => {
    runner.whileIdle(
      (busy) =>
        `App.input was called from inside a ${busy}. The input stage runs between ticks, before one.`
    );
    if (schedule.input.length === 0) {
      return Exit.void;
    }
    // One picture of the devices for the whole stage.
    Object.assign(devices, listener.sample());
    return between("input");
  };

  /** Whether the app was asked if it rests, `app.settled`, since it was made. */
  let resting = false;

  /** Runs one tick. */
  const ticked = (delta: number): Exit.Exit<void, unknown> => {
    runner.ticking = true;
    try {
      // Queued actions are applied before time advances, so they land at the
      // same point in the timeline as an action dispatched between ticks.
      inbox.drain();

      log.ticking(delta);
      time.delta = delta;
      time.elapsed += delta;
      time.tick++;

      events.open();
      runner.running = "";
      const exit = runner.finish(
        () =>
          runTick(
            spans.tick === undefined
              ? ticking
              : Effect.withParentSpan(ticking, spans.tick)
          ),
        `Tick ${time.tick}`,
        () =>
          `System "${runner.running}" did not finish within the tick. Systems must be synchronous: ` +
          `what takes longer than a tick keeps its place in the world, in a component or a state that a system moves on each tick.`,
        true
      );
      commands.apply();
      events.close(time.tick);
      log.ticked();
      // Hashed only once someone asks whether the game rests.
      intake.ticked(
        resting ? world._frameHash(false, Stage.GameTime.component) : undefined
      );
      return exit;
    } finally {
      runner.ticking = false;
    }
  };

  const stepped = (delta: number): Exit.Exit<void, unknown> => {
    runner.whileIdle((busy) => `App.tick was called from inside a ${busy}`);
    // Each tick is asked afresh: one in which nobody asks is the last.
    intake.wanted = false;
    log.start();
    if (!trace) {
      return ticked(delta);
    }
    const span = spans.open("arcadekit/tick", {
      "arcadekit.tick": time.tick + 1,
    });
    spans.tick = span;
    let exit: Exit.Exit<void, unknown> | undefined;
    try {
      exit = ticked(delta);
      return exit;
    } catch (error) {
      exit = Exit.die(error);
      throw error;
    } finally {
      spans.end(span, exit ?? Exit.void);
      spans.tick = undefined;
    }
  };

  return {
    tick: (delta, observe) => {
      // Whoever steps this tick, and nobody who stepped one before.
      observer = observe;
      return stepped(delta);
    },
    frame: runFrameStage,
    input: runInputStage,
    setup: (plugin, setup) => {
      events.reader = `setup:${plugin}`;
      world.reader = events.reader;
      const exit = runner.asOwn(() =>
        runner.finish(
          () => runTick(setup),
          `The setup of plugin "${plugin}"`,
          () =>
            `The setup of plugin "${plugin}" did not finish synchronously. Setup must not wait.`,
          false
        )
      );
      if (Exit.isSuccess(exit)) {
        commands.apply();
      }
      return exit;
    },
    settled: () => {
      if (!resting) {
        // What the next tick is compared with: the world as it is now.
        resting = true;
        intake.rest = world._frameHash(false, Stage.GameTime.component);
      }
      if (
        intake.wanted ||
        intake.queued.length > 0 ||
        runner.pending > 0 ||
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
  };
};
