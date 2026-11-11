import { Context, Effect, Layer, Random, Scope } from "effect";

import { attachError } from "./attach-error";
import type { AttachError } from "./attach-error";
import type { CommandDropped } from "./command";
import { steppedFrames } from "./frame-loop";
import type { GameCrashed } from "./frame-loop";
import { animationFrames } from "./frames";
import type { FrameSource } from "./frames";
import { Loop } from "./loop";
import type { RefusalFor, SimulationClass } from "./simulation";
import type { InputSource } from "./step-input";
import type { GameView } from "./view";

/**
 * What an engine's view and input source are made from, by name: Effects the engine runs on each
 * attach. A service key is one (`Audio`), and so is an asset's load (`MySheet.load`).
 */
export type Uses = Readonly<
  Record<string, Effect.Effect<unknown, unknown, unknown>>
>;

/** What each of `U`'s Effects gave: the second argument of `view` and `input`. */
export type Used<U extends Uses> = {
  readonly [K in keyof U]: Effect.Success<U[K]>;
};

/**
 * The local player of a run: this browser's, among the players the run seats by slot. A view's
 * is read live: a view reads `slot` when it draws, so it follows its player without being made
 * again. An engine seats its one player at slot 0.
 */
export interface LocalPlayer {
  /** The local player's slot in the run's player order: 0 in a single-player run. */
  readonly slot: number;
  /** Every player's name, by slot. None in a single-player run, where nobody is named. */
  readonly names: readonly string[];
}

/** What `view` is given besides the container and what it uses. */
export interface ViewContext {
  /** Whose view it is. A view of several players' run draws it from this player's side. */
  readonly local: LocalPlayer;
}

/**
 * A running game, as an app drives it. Each `Game.Engine` class is the service key of one:
 * `yield* MyEngine`.
 */
export interface Engine<Config, Event, Command, E, Refusals> {
  /**
   * Draws into `element` and reads input from it for as long as it runs: each frame steps the
   * run by the time since the last frame, then draws it. Interrupt it to detach, which disposes
   * the view and the input source.
   *
   * It never succeeds, so run it last. It fails with what one of the engine's `uses` fails with
   * (`E`: an asset that can't be loaded), with `AttachError` if the view or the input source can't be
   * made (no WebGL), and with `GameCrashed` if a frame throws: that frame is the last, and the
   * run ends. Either way nothing is left attached. Attaching an engine that is already attached
   * dies: an engine draws into one element at a time.
   */
  readonly attach: (
    element: HTMLElement
  ) => Effect.Effect<never, AttachError | GameCrashed | E>;
  /** Calls `onEvent` for every event and sample of the run while the scope is open. */
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
   * next step. It succeeds if its `apply` handler took it. It fails with the rejection the
   * handler refused it with, one of those the command declares, and with `CommandDropped` if
   * the rules gave no answer: there is no run, or the run ended first.
   *
   * It completes after the frame of the command's step has drawn, never inside the step, so
   * the line after it may start or stop a run. Its answer and the events of that step arrive in
   * no fixed order.
   *
   * A step needs a frame, so it waits while the engine is paused or not attached, and ends when
   * the run next steps or ends. Interrupt it to take the command back, if it hasn't been applied
   * yet. An app that only cares what the rules said handles the drop alone,
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

/**
 * Where an attached engine gets its frames: `requestAnimationFrame` unless a test provides
 * `manualFrames()` from `arcadekit/game/testing`.
 *
 * ```ts
 * MyEngine.layer.pipe(Layer.provide(Layer.succeed(Game.Frames, manualFrames())));
 * ```
 */
export const Frames: Context.Reference<FrameSource> = Context.Reference(
  "arcadekit/game/Frames",
  { defaultValue: () => animationFrames }
);

/** The key string of the engine named `Name`. */
export type EngineId<Name extends string> = `arcadekit/game/Engine/${Name}`;

/**
 * The type-level identity of an engine's service: what `yield* MyEngine` requires. It is the
 * type of the class's own values, so the class names it: `Layer.Layer<MyEngine>`.
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
 * The class `Game.Engine` returns: the key of its engine service, and the Layer that provides
 * it. `U` is what the engine uses, as it was declared: a failure of one is `attach`'s, and the
 * `layer` needs their services.
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
   * source are made on each attach. It needs the services of what the engine `uses`, such as
   * the app's audio and assets.
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

/** What `Game.Engine` takes: a simulation, and the browser half that draws it and reads its input. */
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
   * engine seats its player at slot 0, and another host of this engine, such as a `Coop`, at
   * the slot its lobby gave.
   */
  readonly view: (
    container: HTMLElement,
    uses: Used<U>,
    context: ViewContext
  ) => GameView<NoInfer<State>>;
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
  readonly view: (container: HTMLElement) => GameView<State>;
  readonly input: (surface: HTMLElement) => InputSource<Input>;
}

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
  const loop = new Loop(simulation);
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
  return {
    // Its own scope: a crash disposes the view and the input source as detaching does.
    attach: (element) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* claim;
          const made = yield* presentation;
          const view = yield* Effect.acquireRelease(
            Effect.try({
              try: () => made.view(element),
              catch: attachError,
            }),
            (drawn) => Effect.sync(() => drawn.dispose())
          );
          const input = yield* Effect.acquireRelease(
            Effect.try({
              try: () => made.input(element),
              catch: attachError,
            }),
            (read) => Effect.sync(() => read.dispose())
          );
          return yield* steppedFrames(loop, frames, input, view);
        })
      ),
    listen: (onEvent) =>
      Effect.acquireRelease(
        Effect.sync(() => loop.subscribe(onEvent)),
        (unsubscribe) => Effect.sync(unsubscribe)
      ).pipe(Effect.asVoid),
    start: (config, options) =>
      Effect.gen(function* () {
        const seed = options?.seed ?? (yield* Random.nextInt);
        // A seed is 32 bits, as core's `makeRng` reads it.
        loop.start(config, seed >>> 0, frames.now());
      }),
    // The loop tells the sender how the command ended: that is this Effect's result.
    // Interrupted while it waits, it takes the command back. It resumes after a yield, so the
    // sender's next line never runs on the frame's stack: the frame has drawn by then, and a
    // frame that threw has ended its run.
    send: (command) =>
      Effect.callback((resume) => {
        const unsend = loop.send(command, 0, (outcome) =>
          resume(
            outcome === undefined
              ? Effect.yieldNow
              : Effect.andThen(Effect.yieldNow, Effect.fail(outcome))
          )
        );
        return Effect.sync(unsend);
      }),
    setPaused: (paused) => Effect.sync(() => loop.setPaused(paused)),
    stop: Effect.sync(() => loop.stop()),
  };
};

/**
 * A game as the browser runs it for one player: a simulation, and the view and input source
 * that draw it and read its input. The class is the key of the engine service an app drives,
 * and its `layer` provides it.
 *
 * ```ts
 * export class PushPuzzleEngine extends Game.Engine("PushPuzzleEngine", {
 *   simulation: PushPuzzle,
 *   uses: {
 *     audio: Audio,
 *     sounds: PushPuzzleCueSounds,
 *     sheet: PushPuzzleSheet.load,
 *   },
 *   view: (container, { audio, sounds, sheet }) =>
 *     Game.combineViews(
 *       new PushPuzzleView(container, sheet),
 *       new PushPuzzleSoundView(audio, sounds)
 *     ),
 *   input: pushPuzzleInput,
 * }) {}
 *
 * // In the app:
 * const engine = yield* PushPuzzleEngine;
 * yield* engine.start({ content, levelId });
 * ```
 *
 * An app's Foldkit Subscription attaches it to the viewport (`arcadekit/foldkit`'s
 * `engineEntry`). To step a simulation with nothing drawn, use `Game.Loop` or a scenario.
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
