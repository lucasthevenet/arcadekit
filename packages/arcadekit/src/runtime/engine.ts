import { Data, Duration, Effect, Exit } from "effect";
import type { Scope } from "effect";

import { messageOf, steppedFrames } from "./frame-loop";
import type { GameCrashed } from "./frame-loop";
import { animationFrames } from "./frames";
import type { FrameSource } from "./frames";
import { GameLoop } from "./loop";
import type { GameDefinition } from "./presentation";

// Named so the type files can be made one file at a time (isolatedDeclarations).
const AttachErrorBase: ReturnType<typeof Data.TaggedError<"AttachError">> =
  Data.TaggedError("AttachError");

/**
 * An engine that couldn't attach: making its view or input source threw, such as Three.js
 * finding no WebGL. `cause` is what was thrown.
 */
export class AttachError extends AttachErrorBase<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** An AttachError for what attaching threw. */
export const attachError = (cause: unknown): AttachError =>
  new AttachError({ message: messageOf(cause), cause });

/**
 * The Effect-facing API of a running game. Scoped methods clean up when their scope closes.
 *
 * Each genre declares its own service key for it, so several genres can coexist. A genre whose
 * game needs no loaded assets provides the engine itself:
 *
 * ```ts
 * class MyEngine extends Context.Service<MyEngine, GameEngine<Config, State, Event>>()('my-game/Engine') {}
 * const MyEngineLayer = Layer.sync(MyEngine, () => makeGameEngine(myGameDefinition))
 * ```
 *
 * A genre whose game draws from assets the app loads (a sprite sheet, ADR-0015) provides an
 * `EngineLoader` instead, made with `makeEngineLoader`: there is no engine before its assets.
 */
export interface GameEngine<Config, State, Event> {
  /**
   * Draws into `element` and reads input from it for as long as it runs: each frame steps the
   * run by the time since the last frame, then draws it. Interrupt it to detach, which
   * disposes the view and the input source.
   *
   * It never succeeds, so run it last: start the run, then `return yield* engine.attach(el)`.
   * It fails with `AttachError` at once if the game's view or input source can't be made, with
   * nothing attached, and with `GameCrashed` if a frame throws: that frame is the last, the run
   * ends, and it detaches. Attaching an engine that is already attached dies: an engine draws
   * into one element at a time.
   *
   * Its failures reach only what waits on it. A forked `attach` that nothing joins loses them
   * silently, so join its fiber (`Fiber.join`) or race the rest of the program against it
   * (`Effect.raceFirst(rest, engine.attach(el))`).
   */
  readonly attach: (
    element: HTMLElement
  ) => Effect.Effect<never, AttachError | GameCrashed>;
  /**
   * Calls `onEvent` for every game event while the scope is open. A listener that throws on an
   * event of a frame crashes the attached engine (`attach` fails with `GameCrashed`); on one
   * that `start` or `modify` reports, it throws on the caller's fiber, and that Effect dies.
   */
  readonly listen: (
    onEvent: (event: Event) => void
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Starts a new run with a random seed. */
  readonly start: (config: Config) => Effect.Effect<void>;
  /** Changes the current run's state, then reports any events that produced. Does nothing with no run. */
  readonly modify: (change: (state: State) => void) => Effect.Effect<void>;
  readonly setPaused: (paused: boolean) => Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
}

/**
 * Runs `definition` in the browser behind a GameEngine: a `GameLoop`, stepped and drawn on
 * each frame while attached. `options.frames` replaces the frame clock (requestAnimationFrame
 * by default); tests pass `manualFrames()` from `arcadekit/runtime/testing`. To step without
 * drawing, use a `GameLoop` instead.
 */
export const makeGameEngine = <Config, State, Input, Event>(
  definition: GameDefinition<Config, State, Input, Event>,
  options: { readonly frames?: FrameSource } = {}
): GameEngine<Config, State, Event> => {
  const frames = options.frames ?? animationFrames;
  const loop = new GameLoop(definition);
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
    // Its own scope: a crash disposes the view and input source as detaching does. The scope
    // runs every release even if one throws, so the engine can always attach again.
    attach: (element) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* claim;
          const view = yield* Effect.acquireRelease(
            Effect.try({
              try: () => definition.createView(element),
              catch: attachError,
            }),
            (made) => Effect.sync(() => made.dispose())
          );
          const input = yield* Effect.acquireRelease(
            Effect.try({
              try: () => definition.createInput(element),
              catch: attachError,
            }),
            (made) => Effect.sync(() => made.dispose())
          );
          return yield* steppedFrames(loop, frames, input, view);
        })
      ),
    listen: (onEvent) =>
      Effect.acquireRelease(
        Effect.sync(() => loop.subscribe(onEvent)),
        (unsubscribe) => Effect.sync(unsubscribe)
      ).pipe(Effect.asVoid),
    start: (config) =>
      Effect.sync(() =>
        loop.start(config, (Math.random() * 2 ** 32) >>> 0, frames.now())
      ),
    modify: (change) => Effect.sync(() => loop.modify(change, frames.now())),
    setPaused: (paused) => Effect.sync(() => loop.setPaused(paused)),
    stop: Effect.sync(() => loop.stop()),
  };
};

/** An engine made from assets the app loaded (ADR-0015), with those assets. */
export interface LoadedEngine<Config, State, Event, Assets> {
  readonly engine: GameEngine<Config, State, Event>;
  readonly assets: Assets;
}

/**
 * The only way to reach an engine whose game draws from loaded assets. There is no engine
 * before `load` succeeds, so nothing can use one without its assets: every use (a Command,
 * `engineEntry`, another client drawing with the assets) goes through `load`. A call made early
 * waits for the load in flight, and a failed load is the typed error `E`, which each caller
 * turns into a Message. Nothing dies and nothing is dropped.
 */
export interface EngineLoader<Config, State, Event, Assets, E> {
  /**
   * Loads the assets and makes the engine from them, once. It keeps the first success. A
   * failure isn't kept, so calling again retries. Concurrent callers share one load, and a
   * caller that leaves doesn't cancel it for the others.
   */
  readonly load: Effect.Effect<LoadedEngine<Config, State, Event, Assets>, E>;
}

/**
 * Makes an `EngineLoader`: `load` runs `assets`, then makes the engine from `game(assets)`.
 * Making the loader loads nothing. The kept assets are freed with `release` when the loader's
 * scope (the app) closes; a view never frees them. If `game` throws, its assets are freed at
 * once and the load dies; the next load retries.
 */
export const makeEngineLoader = <
  Assets,
  E,
  Config,
  State,
  Input,
  Event,
>(options: {
  readonly assets: Effect.Effect<Assets, E>;
  readonly game: (
    assets: NoInfer<Assets>
  ) => GameDefinition<Config, State, Input, Event>;
  /** Frees the kept assets when the loader's scope (the app) closes. A view never does. */
  readonly release: (assets: NoInfer<Assets>) => void;
  /** Replaces the engine's frame clock, as in `makeGameEngine`. */
  readonly frames?: FrameSource;
}): Effect.Effect<
  EngineLoader<Config, State, Event, Assets, E>,
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    let kept: Assets | undefined;
    // The load runs on a fiber the scope doesn't track, so it can finish after the scope closed:
    // then its assets are freed at once.
    let closed = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
        if (kept !== undefined) {
          options.release(kept);
        }
      })
    );
    const load = yield* Effect.cachedWithTTL(
      options.assets.pipe(
        Effect.map((assets) => {
          // Make the game first: assets whose game throws are freed, not kept, and the load dies.
          let definition: GameDefinition<Config, State, Input, Event>;
          try {
            definition = options.game(assets);
          } catch (error) {
            options.release(assets);
            throw error;
          }
          if (closed) {
            options.release(assets);
          } else {
            kept = assets;
          }
          return {
            assets,
            engine: makeGameEngine(
              definition,
              options.frames === undefined ? {} : { frames: options.frames }
            ),
          };
        })
      ),
      (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)
    );
    return { load };
  });

/**
 * The engine behind a loader service: `engineOf(MyEngine)`. A service key is an Effect that
 * yields its service. Fails with the loader's error if no load succeeds.
 */
export const engineOf = <C, S, Ev, A, E, R>(
  loader: Effect.Effect<EngineLoader<C, S, Ev, A, E>, never, R>
): Effect.Effect<GameEngine<C, S, Ev>, E, R> =>
  loader.pipe(
    Effect.flatMap(({ load }) => load),
    Effect.map(({ engine }) => engine)
  );
