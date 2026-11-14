/**
 * The frame loop: what an attached engine or Co-op client draws on, and how a frame that throws
 * ends it.
 *
 * Effect where it waits, plain where it draws (ADR-0024). Each frame is an `Effect.callback` that
 * asks the frame source for the next frame and gives back its canceller, so interrupting the loop
 * cancels the frame it asked for. The frame's work is one plain call inside one `Effect.try`, so
 * the fiber can't yield in the middle of it: a frame draws whole before the browser shows it, and
 * a throw ends the loop before it asks for another frame.
 *
 * @since 0.7.0
 */
import { Effect, Schema } from "effect";
import type { Cause } from "effect";

import type { FrameSource } from "./frames";
import { messageOf } from "./internal/thrown";

/** The class `Schema.TaggedError` makes for `GameCrashed`, written out for isolatedDeclarations. */
type GameCrashedClass = Schema.Class<
  GameCrashed,
  Schema.TaggedStruct<
    "GameCrashed",
    { readonly message: Schema.String; readonly cause: Schema.Defect }
  >,
  Cause.YieldableError
>;

// Named so the type files can be made one file at a time (isolatedDeclarations).
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError makes a class; it is not an error being thrown.
const GameCrashedBase: GameCrashedClass = Schema.TaggedError<GameCrashed>()(
  "GameCrashed",
  { message: Schema.String, cause: Schema.Defect() }
);

/**
 * An attached engine whose frame threw: a step, a render, or a listener of its events. That frame
 * was its last: the run ended, and the engine detached. `cause` is what was thrown.
 *
 * **When to use**
 *
 * Catch it where the app waits on `attach`, to say why instead of leaving a frozen viewport: it
 * is a bug in the game, reported as a failed attach is.
 *
 * **Details**
 *
 * `message` is the throw's own message, for the app to show; `cause` is the throw, for a log.
 * `frameLoop` fails with it too, for anything else an app draws on frames.
 *
 * **Example** (A frame that throws)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { ManualFrames } from "arcadekit/game/testing";
 * import { Effect, Fiber } from "effect";
 *
 * const frames = ManualFrames.make();
 * const crashed = Effect.gen(function* () {
 *   const loop = yield* Effect.forkChild(
 *     Game.frameLoop(frames, () => {
 *       throw new Error("lost context");
 *     }),
 *     { startImmediately: true }
 *   );
 *   ManualFrames.runFrameAt(frames, 16);
 *   return yield* Effect.flip(Fiber.join(loop));
 * });
 * const error = Effect.runSync(crashed);
 * error._tag; // => "GameCrashed"
 * error.message; // => "lost context"
 * ManualFrames.waiting(frames); // => false
 * ```
 *
 * @category errors
 * @since 0.7.0
 */
export class GameCrashed extends GameCrashedBase {}

/**
 * Calls `frame(nowMs)` on every frame of `frames` until one throws, then fails with
 * `GameCrashed` and asks for no other frame.
 *
 * **When to use**
 *
 * To draw anything else an app draws on animation frames, such as a demo scene outside a run. An
 * engine's and a Co-op client's frames run on it.
 *
 * **Details**
 *
 * It asks for a frame, waits for it, and calls `frame` with its time, in one plain call inside
 * one `Effect.try`, before it asks for the next: so the frame's work is whole, and a throw ends
 * the loop before another frame is asked for. Interrupted while it waits, it cancels the frame it
 * asked for. It never yields but to wait for a frame, so the next frame is asked for in the call
 * of the one that drew. A trace shows it as `Game.frameLoop`, for as long as it runs.
 *
 * **Example** (Drawing on frames a test runs)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { ManualFrames } from "arcadekit/game/testing";
 * import { Effect, Fiber } from "effect";
 *
 * const frames = ManualFrames.make();
 * const drawn: number[] = [];
 * const program = Effect.gen(function* () {
 *   const loop = yield* Effect.forkChild(
 *     Game.frameLoop(frames, (nowMs) => {
 *       drawn.push(nowMs);
 *     }),
 *     { startImmediately: true }
 *   );
 *   ManualFrames.runFrameAt(frames, 16);
 *   ManualFrames.runFrameAt(frames, 33);
 *   yield* Fiber.interrupt(loop);
 * });
 * Effect.runSync(program);
 * drawn; // => [16, 33]
 * ManualFrames.waiting(frames); // => false
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const frameLoop: (
  frames: FrameSource,
  frame: (nowMs: number) => void
) => Effect.Effect<never, GameCrashed> = Effect.fn("Game.frameLoop")(function* (
  frames: FrameSource,
  frame: (nowMs: number) => void
) {
  // One frame: its time, once the frame source calls back. Interrupted, it cancels the
  // request.
  const nextFrame = Effect.callback<number>((resume) => {
    const cancel = frames.request((nowMs) => resume(Effect.succeed(nowMs)));
    return Effect.sync(cancel);
  });
  const draw = (nowMs: number) =>
    Effect.try({
      try: () => frame(nowMs),
      catch: (cause) => new GameCrashed({ message: messageOf(cause), cause }),
    });
  // Waiting for the frame is the loop's only yield: one between a frame and the request of
  // the next would ask for it a task later, after the browser may have shown a frame without it.
  return yield* Effect.forever(nextFrame.pipe(Effect.flatMap(draw)), {
    disableYield: true,
  });
});
