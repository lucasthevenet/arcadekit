import { Duration, Effect, Exit } from "effect";
import type { Scope } from "effect";

import { GameDriver } from "./driver";
import type { FrameSource } from "./frames";
import type { GameDefinition } from "./presentation";

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
  /** Renders into `element` and reads input from it while the scope is open. */
  readonly attach: (
    element: HTMLElement
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Calls `onEvent` for every game event while the scope is open. */
  readonly listen: (
    onEvent: (event: Event) => void
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Starts a new run. Without a seed, a random one is used. */
  readonly start: (config: Config, seed?: number) => Effect.Effect<void>;
  /** Changes the current run's state, then reports any events that produced. Does nothing with no run. */
  readonly modify: (change: (state: State) => void) => Effect.Effect<void>;
  readonly setPaused: (paused: boolean) => Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
}

/**
 * Runs `definition` in the browser behind a GameEngine. `options.frames` replaces the frame
 * clock (requestAnimationFrame by default); tests pass `manualFrames()` from
 * `@gamekit/runtime/testing`.
 */
export const makeGameEngine = <Config, State, Input, Event>(
  definition: GameDefinition<Config, State, Input, Event>,
  options: { readonly frames?: FrameSource } = {}
): GameEngine<Config, State, Event> => {
  const driver = new GameDriver(definition, options.frames);
  return {
    attach: (element) =>
      Effect.acquireRelease(
        Effect.sync(() => driver.attach(element)),
        (detach) => Effect.sync(detach)
      ).pipe(Effect.asVoid),
    listen: (onEvent) =>
      Effect.acquireRelease(
        Effect.sync(() => driver.subscribe(onEvent)),
        (unsubscribe) => Effect.sync(unsubscribe)
      ).pipe(Effect.asVoid),
    start: (config, seed) =>
      Effect.sync(() =>
        driver.start(config, seed ?? (Math.random() * 2 ** 32) >>> 0)
      ),
    modify: (change) => Effect.sync(() => driver.modify(change)),
    setPaused: (paused) => Effect.sync(() => driver.setPaused(paused)),
    stop: Effect.sync(() => driver.stop()),
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
 * scope (the app) closes; a view never frees them.
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
          if (closed) {
            options.release(assets);
          } else {
            kept = assets;
          }
          return {
            assets,
            engine: makeGameEngine(
              options.game(assets),
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
