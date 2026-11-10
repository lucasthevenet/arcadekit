import { Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { GameCrashed } from "../../runtime/browser";
import { manualFrames } from "../../runtime/testing";
import { coopFrameLoop } from "./frame-loop";

// The co-op client's frame loop on frames the test runs by hand.

describe(coopFrameLoop, () => {
  it("draws each frame at its time, asking for the next only after it has drawn", async () => {
    const frames = manualFrames();
    const drawn: [number, boolean][] = [];
    const waiting = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          coopFrameLoop(frames, (nowMs) => {
            drawn.push([nowMs, frames.waiting()]);
          }),
          { startImmediately: true }
        );
        frames.runFrameAt(16);
        frames.runFrameAt(33);
        const before = frames.waiting();
        yield* Fiber.interrupt(fiber);
        return [before, frames.waiting()];
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
    const frames = manualFrames();
    const bug = new Error("lost context");
    let runs = 0;
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          coopFrameLoop(frames, () => {
            runs += 1;
            if (runs === 2) {
              throw bug;
            }
          }),
          { startImmediately: true }
        );
        frames.runFrameAt(16);
        frames.runFrameAt(33);
        frames.runFrameAt(50);
        return yield* Fiber.await(fiber);
      })
    );
    expect([exit, runs, frames.waiting()]).toStrictEqual([
      Exit.fail(new GameCrashed({ message: "lost context", cause: bug })),
      2,
      false,
    ]);
  });
});
