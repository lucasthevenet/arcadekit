import { Effect, Fiber, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keyPresses } from "./index";

// No DOM here: Node's EventTarget stands in for the window, and events are plain Events
// carrying the two fields keyPresses reads.

let window: EventTarget;

const keydown = (code: string, repeat = false) => {
  const event = new Event("keydown");
  Object.defineProperty(event, "code", { value: code });
  Object.defineProperty(event, "repeat", { value: repeat });
  window.dispatchEvent(event);
};

const waitUntil = (isDone: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 100 && !isDone(); turn++) {
      yield* Effect.yieldNow;
    }
  });

describe(keyPresses, () => {
  beforeEach(() => {
    window = new EventTarget();
    vi.stubGlobal("window", window);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports each listed key once per press, by code, and stops listening when it ends", async () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const codes = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(
            Stream.take(
              keyPresses(["KeyR", "Escape"], (code) => code),
              2
            )
          )
        );
        yield* waitUntil(() => added.mock.calls.length > 0);
        keydown("KeyR", true);
        keydown("KeyX");
        keydown("KeyR");
        keydown("Escape");
        return yield* Fiber.join(fiber);
      })
    );
    expect(codes).toStrictEqual(["KeyR", "Escape"]);
    expect(removed).toHaveBeenCalledOnce();
  });
});
