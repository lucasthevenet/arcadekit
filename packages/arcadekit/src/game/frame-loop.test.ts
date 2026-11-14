import { Cause, Effect, Exit, Fiber, Option } from "effect";
import { describe, expect, it } from "vitest";

import { GameCrashed, frameLoop } from "./browser";
import { ManualFrames } from "./testing";

// The frame loop on frames the test runs by hand.

/**
 * The reasons an exit failed with, each a `Fail`'s error or the reason itself. The frame loop is
 * traced, so its failure carries its span as an annotation, which this leaves out.
 */
const failures = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? "succeeded"
    : exit.cause.reasons.map((reason) =>
        Cause.isFailReason(reason) ? reason.error : reason
      );

describe(frameLoop, () => {
  it("draws each frame at its time, asking for the next only after it has drawn", async () => {
    const frames = ManualFrames.make();
    const drawn: [number, boolean][] = [];
    const waiting = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          frameLoop(frames, (nowMs) => {
            drawn.push([nowMs, ManualFrames.waiting(frames)]);
          }),
          { startImmediately: true }
        );
        ManualFrames.runFrameAt(frames, 16);
        ManualFrames.runFrameAt(frames, 33);
        const before = ManualFrames.waiting(frames);
        yield* Fiber.interrupt(fiber);
        return [before, ManualFrames.waiting(frames)];
      })
    );
    // While a frame draws, no other is asked for; interrupted, it cancels the one it asked for.
    expect([drawn, waiting]).toStrictEqual([
      [
        [16, false],
        [33, false],
      ],
      [true, false],
    ]);
  });

  it("fails with GameCrashed when a frame throws, and asks for no other frame", async () => {
    const frames = ManualFrames.make();
    const bug = new Error("lost context");
    let runs = 0;
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          frameLoop(frames, () => {
            runs += 1;
            if (runs === 2) {
              throw bug;
            }
          }),
          { startImmediately: true }
        );
        ManualFrames.runFrameAt(frames, 16);
        ManualFrames.runFrameAt(frames, 33);
        ManualFrames.runFrameAt(frames, 50);
        return yield* Fiber.await(fiber);
      })
    );
    expect([failures(exit), runs, ManualFrames.waiting(frames)]).toStrictEqual([
      [new GameCrashed({ message: "lost context", cause: bug })],
      2,
      false,
    ]);
    // A tagged error's `message` and `cause` aren't enumerable, so the comparison above holds
    // the error's class and neither of them.
    const error = Option.getOrUndefined(Exit.findErrorOption(exit));
    expect(error).toMatchObject({
      _tag: "GameCrashed",
      message: "lost context",
    });
    expect(error?.cause).toBe(bug);
  });
});
