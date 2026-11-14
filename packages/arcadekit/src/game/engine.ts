/**
 * Engines: a game as the browser runs it for one player, its simulation and the view and input
 * source that draw a run and read its input.
 *
 * `Game.Engine` is a declaration with a service: the class is the key of the running engine an
 * app drives, and its `layer` provides it. The engine is Effect where it has a lifecycle (an
 * attach, what it acquires and releases, a send that waits for the rules' answer) and plain where
 * a frame runs: the view, the input source and the listeners are called inside the frame's one
 * `Effect.try`.
 *
 * @since 0.7.0
 */
import {
  Context,
  Effect,
  Inspectable,
  Layer,
  Pipeable,
  Predicate,
  Random,
  Scope,
} from "effect";

import { AttachError } from "./attach-error";
import type { CommandDropped } from "./command";
import { frameLoop } from "./frame-loop";
import type { GameCrashed } from "./frame-loop";
import { Frames } from "./frames";
import type { FrameSource } from "./frames";
import { messageOf } from "./internal/thrown";
import { makeLoop } from "./loop";
import type { Loop } from "./loop";
import type { RefusalFor, SimulationClass } from "./simulation";
import type { InputSource } from "./step-input";
import type { View } from "./view";

const TypeId = "~arcadekit/game/browser/Engine";

/**
 * What an engine's view and input source are made from, by name: Effects the engine runs on each
 * attach. A service key is one (`AudioSystem.AudioSystem`), and so is an asset's load (`MySheet.load`).
 *
 * **When to use**
 *
 * As an engine's `uses`, written in place in its definition.
 *
 * **Example** (What a view is made from)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Effect } from "effect";
 *
 * const uses: Game.Uses = { color: Effect.succeed("#e0b040") };
 * Object.keys(uses); // => ["color"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Uses = Readonly<
  Record<string, Effect.Effect<unknown, unknown, unknown>>
>;

/**
 * What each of `U`'s Effects gave: the second argument of `view` and `input`.
 *
 * **When to use**
 *
 * To annotate a `view` or an `input` written apart from its engine.
 *
 * **Example** (A view's second argument)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import type { Effect } from "effect";
 *
 * type RaceUses = { readonly color: Effect.Effect<string> };
 * const used: Game.Used<RaceUses> = { color: "#e0b040" };
 * used.color; // => "#e0b040"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type Used<U extends Uses> = {
  readonly [K in keyof U]: Effect.Success<U[K]>;
};

/**
 * The local player of a run: this browser's, among the players the run seats by slot.
 *
 * **When to use**
 *
 * In a view of a run several players share, to draw it from this player's side: read `slot` when
 * it draws, so it follows its player without being made again.
 *
 * **Details**
 *
 * An engine seats its one player at slot 0, with nobody named; a Co-op client
 * (`arcadekit/net/browser`) at the slot its lobby gave, with every player's name.
 *
 * **Example** (The one player of an engine)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 *
 * const local: Game.LocalPlayer = { slot: 0, names: [] };
 * local.slot; // => 0
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface LocalPlayer {
  /** The local player's slot in the run's player order: 0 in a single-player run. */
  readonly slot: number;
  /** Every player's name, by slot. None in a single-player run, where nobody is named. */
  readonly names: readonly string[];
}

/**
 * What `view` is given besides the container and what it uses: whose view it is.
 *
 * **When to use**
 *
 * To annotate a `view` written apart from its engine, which a Co-op client also makes.
 *
 * **Example** (A view that draws from its player's side)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 *
 * const sideOf = ({ local }: Game.ViewContext): string =>
 *   local.names[local.slot] ?? `player ${local.slot}`;
 * sideOf({ local: { slot: 1, names: ["Ana", "Bo"] } }); // => "Bo"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface ViewContext {
  /** Whose view it is. A view of several players' run draws it from this player's side. */
  readonly local: LocalPlayer;
}

/**
 * A running game, as an app drives it: what `yield* MyEngine` gives. Each `Game.Engine` class is
 * the key of one.
 *
 * **When to use**
 *
 * In an app's Effects, to start a run, send it commands, hear its events and attach it to the
 * viewport. Name one with `Game.EngineOf<typeof MySimulation>`.
 *
 * **Details**
 *
 * Its Effects are fields, as a service's are, and each is traced under the declared name:
 * `RaceEngine.attach`, `RaceEngine.send` and so on. Its value has a `TypeId`, `pipe` and a
 * printed form, and `Game.isEngine` recognises it.
 *
 * **Example** (Starting a run and stopping it)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Effect, Schema } from "effect";
 *
 * class Hud extends Game.Event("Hud", { steps: Schema.Int }) {}
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Null,
 *   create: () => ({ steps: 0 }),
 *   step: () => {},
 *   sample: { event: Hud, read: (count) => ({ steps: count.steps }) },
 * }) {}
 * class CountEngine extends Game.Engine("CountEngine", {
 *   simulation: Count,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => null, dispose: () => {} }),
 * }) {}
 *
 * const heard: number[] = [];
 * const program = Effect.gen(function* () {
 *   const engine = yield* CountEngine;
 *   yield* engine.listen(Count.match({ Hud: ({ steps }) => heard.push(steps) }));
 *   yield* engine.start(null, { seed: 1 });
 *   yield* engine.stop;
 * });
 * Effect.runSync(program.pipe(Effect.scoped, Effect.provide(CountEngine.layer)));
 * heard; // => [0]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Engine<Config, Event, Command, E, Refusals>
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /**
   * Draws into `element` and reads input from it for as long as it runs: each frame steps the
   * run by the time since the last frame, then draws it. Interrupt it to detach, which disposes
   * the view and the input source.
   *
   * It never succeeds, so run it last. It fails with what one of the engine's `uses` fails with
   * (`E`: an asset that can't be loaded), with `AttachError` if the view or the input source can't
   * be made (no WebGL), and with `GameCrashed` if a frame throws: that frame is the last, and the
   * run ends. Either way nothing is left attached. Attaching an engine that is already attached
   * dies: an engine draws into one element at a time.
   */
  readonly attach: (
    element: HTMLElement
  ) => Effect.Effect<never, AttachError | GameCrashed | E>;
  /**
   * Calls `onEvent` for every event and sample of the run while the scope is open, in the order
   * the run reports them: inside `start`, what `create` reports and then the first sample; inside
   * each frame, the events of its steps and then its sample, if one is due. It is called before
   * the frame draws, and before any `send` that frame answered completes. It is a plain call in
   * the middle of that work, so it only notes what it hears.
   */
  readonly listen: (
    onEvent: (event: Event) => void
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Starts a new run, replacing any current one. Without a `seed`, it draws a random one. */
  readonly start: (
    config: Config,
    options?: { readonly seed?: number }
  ) => Effect.Effect<void>;
  /**
   * Sends a command to the run and waits for the rules' answer: they get it at the start of the
   * next step. It succeeds if its `apply` handler took it. It fails with the rejection the handler
   * refused it with, one of those the command declares, and with `CommandDropped` if the rules
   * gave no answer: there is no run, or the run ended first.
   *
   * It completes after the frame of the command's step has drawn, never inside the step, so the
   * line after it may start or stop a run. By then a listener (`listen`) has been called with
   * everything that frame reported: the events of each of its steps, the command's step among
   * them, then its sample if one was due. So an Effect that listens and then sends knows, on the
   * line after the send, what the command's step did, such as whether a pick opened another offer.
   *
   * That holds whenever the rules answered, whether they took the command or refused it, with one
   * exception: a frame that throws before its listeners have heard it all, as `attach` fails with
   * `GameCrashed`. A command one of its steps had applied still gets the rules' answer. But if a
   * step threw, what the frame had reported is discarded with its run and reaches no listener; and
   * if a listener threw, the telling ended there: the listeners called before it heard that event,
   * and none heard what came after. A render that throws comes after both, so the listeners heard
   * its whole frame. A send that fails with `CommandDropped` had no step to hear of; if a new
   * `start` dropped it, the listener has heard that run's start.
   *
   * The order is that of the two calls, not of Messages. An app's Subscription makes a Message of
   * each event and its Command another of the send's result, and the kit fixes no order between
   * those in `update`: a Command that needs what its command's step reported listens itself.
   *
   * A step needs a frame, so it waits while the engine is paused or not attached, and ends when the
   * run next steps or ends. Interrupt it to take the command back, if it hasn't been applied yet.
   * An app that only cares what the rules said handles the drop alone,
   * `Effect.catchTag("CommandDropped", () => Effect.void)`; `Effect.ignore` hides a refusal too.
   */
  readonly send: <C extends Command>(
    command: C
  ) => Effect.Effect<void, RefusalFor<Refusals, C> | CommandDropped>;
  /** While paused, frames draw but don't step. */
  readonly setPaused: (paused: boolean) => Effect.Effect<void>;
  /** Ends the run: the view then draws no state. */
  readonly stop: Effect.Effect<void>;
}

/** What the engine keeps of its own, which no caller reads. */
type Internal = Engine<unknown, unknown, unknown, unknown, unknown> & {
  /** The declared name, for a printed engine. */
  readonly engineName: string;
};

const EngineProto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Internal) {
    return { _id: "Engine", engine: this.engineName };
  },
};

/**
 * Checks whether a value is a running engine.
 *
 * **When to use**
 *
 * Narrow an unknown value before attaching it.
 *
 * **Example** (Recognising an engine)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Effect, Schema } from "effect";
 *
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Null,
 *   create: () => ({ steps: 0 }),
 *   step: () => {},
 * }) {}
 * class CountEngine extends Game.Engine("CountEngine", {
 *   simulation: Count,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => null, dispose: () => {} }),
 * }) {}
 *
 * const read = Effect.gen(function* () {
 *   return yield* CountEngine;
 * });
 * const engine = Effect.runSync(read.pipe(Effect.provide(CountEngine.layer)));
 * Game.isEngine(engine); // => true
 * Game.isEngine({ attach: () => Effect.never }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isEngine = (
  value: unknown
): value is Engine<unknown, unknown, unknown, unknown, unknown> =>
  Predicate.hasProperty(value, TypeId);

/**
 * The key string of the engine named `Name`.
 *
 * **When to use**
 *
 * Rarely: it is part of the engine's type, which a game names by its class.
 *
 * **Example** (An engine's key)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Schema } from "effect";
 *
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Null,
 *   create: () => ({}),
 *   step: () => {},
 * }) {}
 * class CountEngine extends Game.Engine("CountEngine", {
 *   simulation: Count,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => null, dispose: () => {} }),
 * }) {}
 *
 * const key: Game.EngineId<"CountEngine"> = CountEngine.key;
 * key; // => "arcadekit/game/Engine/CountEngine"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type EngineId<Name extends string> = `arcadekit/game/Engine/${Name}`;

/**
 * The type-level identity of an engine's service: what `yield* MyEngine` requires. It is the type
 * of the class's own values, so the class names it: `Layer.Layer<MyEngine>`.
 *
 * **When to use**
 *
 * Rarely: name the class instead, as a requirement or a Layer's service.
 *
 * **Example** (The class names its service)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Layer, Schema } from "effect";
 *
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Null,
 *   create: () => ({}),
 *   step: () => {},
 * }) {}
 * class CountEngine extends Game.Engine("CountEngine", {
 *   simulation: Count,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => null, dispose: () => {} }),
 * }) {}
 *
 * const layer: Layer.Layer<CountEngine> = CountEngine.layer;
 * Layer.isLayer(layer); // => true
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type EngineService<
  Name extends string,
  Config,
  Event,
  Command,
  E,
  Refusals,
> = Context.ServiceClass.Shape<
  EngineId<Name>,
  Engine<Config, Event, Command, E, Refusals>
>;

/**
 * The class `Game.Engine` returns: the key of its engine service, and the Layer that provides it.
 * `U` is what the engine uses, as it was declared: a failure of one is `attach`'s, and the `layer`
 * needs their services.
 *
 * **When to use**
 *
 * To type a value that is some engine's class, as a host of the same game does: a `Coop`
 * (`arcadekit/net/browser`) takes one. A game names its own class.
 *
 * **Example** (What the class holds)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Schema } from "effect";
 *
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Null,
 *   create: () => ({}),
 *   step: () => {},
 * }) {}
 * class CountEngine extends Game.Engine("CountEngine", {
 *   simulation: Count,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => null, dispose: () => {} }),
 * }) {}
 *
 * CountEngine.kind; // => "Engine"
 * CountEngine.engineName; // => "CountEngine"
 * CountEngine.simulation === Count; // => true
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface EngineClass<
  Name extends string,
  Config,
  State,
  Input,
  Event,
  Command,
  U extends Uses,
  Refusals,
> extends Context.ServiceClass<
  EngineService<
    Name,
    Config,
    Event,
    Command,
    Effect.Error<U[keyof U]>,
    Refusals
  >,
  EngineId<Name>,
  Engine<Config, Event, Command, Effect.Error<U[keyof U]>, Refusals>
> {
  readonly kind: "Engine";
  readonly engineName: Name;
  readonly simulation: SimulationClass<
    string,
    Config,
    State,
    Input,
    Event,
    Command,
    Refusals
  >;
  /**
   * What the engine was declared with. Another host of the same game reads it: a `Coop`
   * (`arcadekit/net/browser`) runs `uses` and makes the `view` as the engine does, for the seat
   * its lobby gave.
   */
  readonly definition: EngineDefinition<
    Config,
    State,
    Input,
    Event,
    Command,
    U,
    Refusals
  >;
  /**
   * Provides the engine. Building it makes nothing and loads nothing: the view and the input
   * source are made on each attach. It needs the services of what the engine `uses`, such as the
   * app's audio and assets.
   */
  readonly layer: Layer.Layer<
    EngineService<
      Name,
      Config,
      Event,
      Command,
      Effect.Error<U[keyof U]>,
      Refusals
    >,
    never,
    Exclude<Effect.Services<U[keyof U]>, Scope.Scope>
  >;
}

/**
 * What `Game.Engine` takes: a simulation, and the browser half that draws it and reads its input.
 *
 * **When to use**
 *
 * Rarely: a game writes its definition in place, in the builder's call, where TypeScript types
 * the view's state and the input from the simulation.
 *
 * **Details**
 *
 * `uses` runs once per attach, in the attach's scope, before anything is made. `view` is called
 * once per attach, first, then `input`; the input source is disposed first when the engine
 * detaches.
 *
 * **Example** (A definition's fields)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Schema } from "effect";
 *
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Null,
 *   create: (_config: null) => ({ steps: 0 }),
 *   step: () => {},
 * }) {}
 *
 * const definition: Game.EngineDefinition<null, { steps: number }, null, never, never, {}, {}> = {
 *   simulation: Count,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => null, dispose: () => {} }),
 * };
 * definition.simulation.simulationName; // => "Count"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface EngineDefinition<
  Config,
  State,
  Input,
  Event,
  Command,
  U extends Uses,
  Refusals,
> {
  /** The rules the engine runs. */
  readonly simulation: SimulationClass<
    string,
    Config,
    State,
    Input,
    Event,
    Command,
    Refusals
  >;
  /**
   * What the view and the input source are made from. Each Effect runs once per attach, in the
   * attach's scope, before anything is made: a service the app provides, an asset it loads, or
   * something the view and the input share for that attach (a camera's state). A failure of one
   * is `attach`'s.
   */
  readonly uses?: U;
  /**
   * Makes the view that draws into the viewport element. Called once per attach, first. A view
   * reads the state on every frame and never changes it; several views are one with
   * `combineViews`. A view of a run several players share reads `local.slot` when it draws: the
   * engine seats its player at slot 0, and another host of this engine, such as a `Coop`, at the
   * slot its lobby gave.
   */
  readonly view: (
    container: HTMLElement,
    uses: Used<U>,
    context: ViewContext
  ) => View<NoInfer<State>>;
  /** Makes the input source that reads each step's input from the viewport element. Called once per attach, after `view`. */
  readonly input: (
    surface: HTMLElement,
    uses: Used<U>
  ) => InputSource<NoInfer<Input>>;
}

/** The one player of an engine's run: slot 0, and nobody to name. */
const SOLO: ViewContext = { local: { slot: 0, names: [] } };

/** The view and input source factories of one attach, with what they use already given. */
interface Presentation<State, Input> {
  readonly view: (container: HTMLElement) => View<State>;
  readonly input: (surface: HTMLElement) => InputSource<Input>;
}

/** How a send ends, once the rules answered: after a yield, then with their refusal if any. */
type Answer = Effect.Effect<void, unknown>;

/** What making the view or the input source threw, as the typed failure of `attach`. */
const attachError = (cause: unknown): AttachError =>
  new AttachError({ message: messageOf(cause), cause });

/**
 * An attached engine's frames, until one throws: step `loop` by the time since the last frame,
 * then draw. A frame that throws also ends `loop`'s run: a step that threw left its state
 * half-changed and is still owed on the clock, so attaching again would run it again on its first
 * frame. An interrupt, which is a detach, leaves the run as it is.
 */
const steppedFrames = <Config, State, Input, Event, Command, Refusals>(
  loop: Loop<Config, State, Input, Event, Command, Refusals>,
  frames: FrameSource,
  input: InputSource<Input>,
  view: View<State>
): Effect.Effect<never, GameCrashed> => {
  let lastMs = frames.now();
  // Kept in place: the budget is the frame's, and nothing keeps it after the frame.
  const budget = { seconds: 0 };
  return frameLoop(frames, (nowMs) => {
    // requestAnimationFrame passes the time its frame began, which can be before attach.
    budget.seconds = Math.max(0, nowMs - lastMs) / 1000;
    lastMs = nowMs;
    loop.frame(input, budget, nowMs);
    view.render(loop.state, nowMs / 1000);
  }).pipe(Effect.tapError(() => Effect.sync(() => loop.stop())));
};

const makeEngine = <Config, State, Input, Event, Command, E, Refusals>(
  name: string,
  simulation: SimulationClass<
    string,
    Config,
    State,
    Input,
    Event,
    Command,
    Refusals
  >,
  presentation: Effect.Effect<Presentation<State, Input>, E, Scope.Scope>,
  frames: FrameSource
): Engine<Config, Event, Command, E, Refusals> => {
  const loop = makeLoop(simulation);
  let attached = false;
  // Attaching twice at once is a programming error, so it dies rather than fail.
  const claim = Effect.acquireRelease(
    Effect.suspend(() => {
      if (attached) {
        return Effect.die(
          new Error(
            `Engine "${name}" is already attached to an element. An engine draws into one element at a time: interrupt the first attach, which detaches it, before attaching again.`
          )
        );
      }
      attached = true;
      return Effect.void;
    }),
    () =>
      Effect.sync(() => {
        attached = false;
      })
  );
  // Its own scope: a crash disposes the view and the input source as detaching does.
  const attach = Effect.fn(`${name}.attach`)(function* (element: HTMLElement) {
    yield* claim;
    const made = yield* presentation;
    const view = yield* Effect.acquireRelease(
      Effect.try({ try: () => made.view(element), catch: attachError }),
      (drawn) => Effect.sync(() => drawn.dispose())
    );
    const input = yield* Effect.acquireRelease(
      Effect.try({ try: () => made.input(element), catch: attachError }),
      (read) => Effect.sync(() => read.dispose())
    );
    return yield* steppedFrames(loop, frames, input, view);
  }, Effect.scoped);
  const listen = Effect.fn(`${name}.listen`)(function* (
    onEvent: (event: Event) => void
  ) {
    yield* Effect.acquireRelease(
      Effect.sync(() => loop.subscribe(onEvent)),
      (unsubscribe) => Effect.sync(unsubscribe)
    );
  });
  const start = Effect.fn(`${name}.start`)(function* (
    config: Config,
    options?: { readonly seed?: number }
  ) {
    const seed = options?.seed ?? (yield* Random.nextInt);
    // A seed is 32 bits, as core's `Rng.make` reads it.
    yield* Effect.sync(() => loop.start(config, seed >>> 0, frames.now()));
  });
  // The loop tells the sender how the command ended: that is this Effect's result. Interrupted
  // while it waits, it takes the command back. It resumes after a yield, so the sender's next
  // line never runs on the frame's stack: the frame has drawn by then, and a frame that threw
  // has ended its run.
  const send = Effect.fn(`${name}.send`)(function* (command: Command) {
    return yield* Effect.callback((resume: (answer: Answer) => void) => {
      const unsend = loop.send(command, 0, (outcome) =>
        resume(
          outcome === undefined
            ? Effect.yieldNow
            : Effect.andThen(Effect.yieldNow, Effect.fail(outcome))
        )
      );
      return Effect.sync(unsend);
    });
  }) as Engine<Config, Event, Command, E, Refusals>["send"];
  const setPaused = Effect.fn(`${name}.setPaused`)(function* (paused: boolean) {
    yield* Effect.sync(() => loop.setPaused(paused));
  });
  const stop = Effect.sync(() => loop.stop()).pipe(
    Effect.withSpan(`${name}.stop`)
  );
  return Object.assign(Object.create(EngineProto) as object, {
    engineName: name,
    attach,
    listen,
    start,
    send,
    setPaused,
    stop,
  }) as unknown as Engine<Config, Event, Command, E, Refusals>;
};

/**
 * Declares an engine: a game as the browser runs it for one player, its simulation and the view
 * and input source that draw a run and read its input. The class is the key of the engine service
 * an app drives, and its `layer` provides it.
 *
 * **When to use**
 *
 * Once per game that runs in the browser. An app's Foldkit Subscription attaches it to the
 * viewport (`arcadekit/foldkit`'s `EngineEntry.make`). To step a simulation with nothing drawn, use a
 * loop or a scenario.
 *
 * **Details**
 *
 * `uses` names Effects run on each attach, in its scope, before the view and the input source are
 * made: the app's audio, an asset's load, something the two share. The view and the input are
 * plain functions, called once per attach and disposed when the engine detaches; a throw from
 * either fails `attach` with `AttachError`. Each frame steps the run by the time since the last,
 * then draws.
 *
 * **Example** (An engine on frames a test runs)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { ManualFrames } from "arcadekit/game/testing";
 * import { Effect, Layer, Schema } from "effect";
 *
 * class Count extends Game.Simulation("Count", {
 *   stepSeconds: 1 / 64,
 *   input: Schema.Null,
 *   create: () => ({ steps: 0 }),
 *   step: (count) => {
 *     count.steps += 1;
 *   },
 * }) {}
 *
 * const drawn: (number | null)[] = [];
 * class CountEngine extends Game.Engine("CountEngine", {
 *   simulation: Count,
 *   view: () => ({
 *     render: (count) => {
 *       drawn.push(count?.steps ?? null);
 *     },
 *     dispose: () => {},
 *   }),
 *   input: () => ({ read: () => null, dispose: () => {} }),
 * }) {}
 *
 * const frames = ManualFrames.make();
 * const play = Effect.gen(function* () {
 *   const engine = yield* CountEngine;
 *   yield* engine.start(null, { seed: 1 });
 *   yield* Effect.forkScoped(engine.attach({} as HTMLElement), { startImmediately: true });
 *   ManualFrames.runFrameAt(frames, 15.625);
 *   ManualFrames.runFrameAt(frames, 31.25);
 * });
 * const frameSource = Layer.succeed(Game.Frames, frames);
 * Effect.runSync(play.pipe(Effect.scoped, Effect.provide(CountEngine.layer), Effect.provide(frameSource)));
 * drawn; // => [1, 2]
 * ```
 *
 * @category declarations
 * @since 0.7.0
 */
export const make = <
  const Name extends string,
  Config,
  State,
  Input,
  Event,
  Command,
  Refusals,
  const U extends Uses = Record<never, never>,
>(
  name: Name,
  definition: EngineDefinition<
    Config,
    State,
    Input,
    Event,
    Command,
    U,
    Refusals
  >
): EngineClass<Name, Config, State, Input, Event, Command, U, Refusals> => {
  type E = Effect.Error<U[keyof U]>;
  type R = Effect.Services<U[keyof U]>;
  const Key = Context.Service<
    EngineService<Name, Config, Event, Command, E, Refusals>,
    Engine<Config, Event, Command, E, Refusals>
  >()(`arcadekit/game/Engine/${name}` as EngineId<Name>);
  const uses = Effect.all(definition.uses ?? {}) as unknown as Effect.Effect<
    Used<U>,
    E,
    R
  >;
  const layer = Layer.effect(
    Key,
    Effect.gen(function* () {
      // What the engine uses is taken once, here, so `attach` needs nothing but its scope. The
      // layer's own scope is left out: what an attach acquires is released when it detaches.
      const context = Context.omit(Scope.Scope)(
        yield* Effect.context<Exclude<R, Scope.Scope>>()
      );
      const frames = yield* Frames;
      const presentation = uses.pipe(
        Effect.map((used): Presentation<State, Input> => ({
          view: (container) => definition.view(container, used, SOLO),
          input: (surface) => definition.input(surface, used),
        })),
        Effect.provideContext(context)
      ) as Effect.Effect<Presentation<State, Input>, E, Scope.Scope>;
      return makeEngine(name, definition.simulation, presentation, frames);
    })
  );
  return class extends Key {
    static readonly kind = "Engine" as const;
    static readonly engineName: Name = name;
    static readonly simulation = definition.simulation;
    static readonly definition = definition;
    static readonly layer = layer;
  } as unknown as EngineClass<
    Name,
    Config,
    State,
    Input,
    Event,
    Command,
    U,
    Refusals
  >;
};
