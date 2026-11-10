import { Context, Effect, Layer, Random, Scope } from "effect";

import {
  animationFrames,
  attachError,
  steppedFrames,
} from "../runtime/browser";
import type {
  AttachError,
  FrameSource,
  GameCrashed,
  GameView,
} from "../runtime/browser";
import type { InputSource } from "../runtime/index";
import { Loop } from "./loop";
import type { SimulationClass } from "./simulation";

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
 * A running game, as an app drives it. Each `Game.Engine` class is the service key of one:
 * `yield* MyEngine`.
 */
export interface Engine<Config, Event, Command, E = never> {
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
  /** Sends a command to the run: it is applied at the start of the next step. Does nothing with no run. */
  readonly send: (command: Command) => Effect.Effect<void>;
  /** While paused, frames draw but don't step. */
  readonly setPaused: (paused: boolean) => Effect.Effect<void>;
  /** Ends the run: the view then draws no state. */
  readonly stop: Effect.Effect<void>;
}

/**
 * Where an attached engine gets its frames: `requestAnimationFrame` unless a test provides
 * `manualFrames()` from `arcadekit/runtime/testing`.
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
> = Context.ServiceClass.Shape<
  EngineId<Name>,
  Engine<Config, Event, Command, E>
>;

/** The class `Game.Engine` returns: the key of its engine service, and the Layer that provides it. */
export interface EngineClass<
  Name extends string,
  Config,
  State,
  Input,
  Event,
  Command,
  E,
  R,
> extends Context.ServiceClass<
  EngineService<Name, Config, Event, Command, E>,
  EngineId<Name>,
  Engine<Config, Event, Command, E>
> {
  readonly kind: "Engine";
  readonly engineName: Name;
  readonly simulation: SimulationClass<
    string,
    Config,
    State,
    Input,
    Event,
    Command
  >;
  /**
   * Provides the engine. Building it makes nothing and loads nothing: the view and the input
   * source are made on each attach. It needs the services of what the engine `uses`, such as
   * the app's audio and assets.
   */
  readonly layer: Layer.Layer<
    EngineService<Name, Config, Event, Command, E>,
    never,
    Exclude<R, Scope.Scope>
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
> {
  /** The rules the engine runs. */
  readonly simulation: SimulationClass<
    string,
    Config,
    State,
    Input,
    Event,
    Command
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
   * `combineViews`.
   */
  readonly view: (
    container: HTMLElement,
    uses: Used<U>
  ) => GameView<NoInfer<State>>;
  /** Makes the input source that reads each step's input from the viewport element. Called once per attach, after `view`. */
  readonly input: (
    surface: HTMLElement,
    uses: Used<U>
  ) => InputSource<NoInfer<Input>>;
}

/** The view and input source factories of one attach, with what they use already given. */
interface Presentation<State, Input> {
  readonly view: (container: HTMLElement) => GameView<State>;
  readonly input: (surface: HTMLElement) => InputSource<Input>;
}

const makeEngine = <Config, State, Input, Event, Command, E>(
  simulation: SimulationClass<string, Config, State, Input, Event, Command>,
  presentation: Effect.Effect<Presentation<State, Input>, E, Scope.Scope>,
  frames: FrameSource
): Engine<Config, Event, Command, E> => {
  const loop = new Loop(simulation);
  let attached = false;
  // Attaching twice at once is a programming error, so it dies rather than fail.
  const claim = Effect.acquireRelease(
    Effect.suspend(() => {
      if (attached) {
        return Effect.die(
          new Error("This engine is already attached to an element")
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
    send: (command) => Effect.sync(() => loop.send(command)),
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
 *   uses: { sheet: PushPuzzleSheet.load, audio: Audio },
 *   view: (container, { sheet, audio }) =>
 *     Game.combineViews(
 *       new PushPuzzleView(container, sheet),
 *       new PushPuzzleSoundView(audio)
 *     ),
 *   input: createInput,
 * }) {}
 *
 * // In the app:
 * const engine = yield* PushPuzzleEngine;
 * yield* engine.start({ content, levelId });
 * ```
 *
 * An app's Foldkit Subscription attaches it to the viewport (`arcadekit/foldkit`'s
 * `engineEntry`). To step a simulation with nothing drawn, use `Game.Loop` or a story.
 */
export const make = <
  const Name extends string,
  Config,
  State,
  Input,
  Event,
  Command,
  const U extends Uses = Record<never, never>,
>(
  name: Name,
  definition: EngineDefinition<Config, State, Input, Event, Command, U>
): EngineClass<
  Name,
  Config,
  State,
  Input,
  Event,
  Command,
  Effect.Error<U[keyof U]>,
  Effect.Services<U[keyof U]>
> => {
  type E = Effect.Error<U[keyof U]>;
  type R = Effect.Services<U[keyof U]>;
  const Key = Context.Service<
    EngineService<Name, Config, Event, Command, E>,
    Engine<Config, Event, Command, E>
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
          view: (container) => definition.view(container, used),
          input: (surface) => definition.input(surface, used),
        })),
        Effect.provideContext(context)
      ) as Effect.Effect<Presentation<State, Input>, E, Scope.Scope>;
      return makeEngine(definition.simulation, presentation, frames);
    })
  );
  return class extends Key {
    static readonly kind = "Engine" as const;
    static readonly engineName: Name = name;
    static readonly simulation = definition.simulation;
    static readonly layer = layer;
  } as unknown as EngineClass<Name, Config, State, Input, Event, Command, E, R>;
};
