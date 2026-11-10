import { Data, Effect } from "effect";
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
 * Each genre declares its own service key for it, so several genres can coexist:
 *
 * ```ts
 * class MyEngine extends Context.Service<MyEngine, GameEngine<Config, State, Event>>()('my-game/Engine') {}
 * const MyEngineLayer = Layer.sync(MyEngine, () => makeGameEngine(myGameDefinition))
 * ```
 *
 * A game that draws from assets the app loads (a sprite sheet, ADR-0015) declares a
 * `Game.Engine` (`arcadekit/game/browser`) instead, whose `uses` names each asset's load.
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
