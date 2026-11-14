import { Effect, Fiber, Stream } from "effect";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { KeyPresses } from "../../src/foldkit/index";

// No DOM here: Node's EventTarget stands in for the window, and events are plain Events
// carrying the two fields a key press reads.

const keydown = (target: EventTarget, code: string, repeat = false) => {
  const event = new Event("keydown");
  Object.defineProperty(event, "code", { value: code });
  Object.defineProperty(event, "repeat", { value: repeat });
  target.dispatchEvent(event);
};

const waitUntil = (isDone: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 100 && !isDone(); turn++) {
      yield* Effect.yieldNow;
    }
  });

describe("KeyPresses.make", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports each listed key once per press, by code, and stops listening when it ends", async () => {
    const window = new EventTarget();
    vi.stubGlobal("window", window);
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const codes = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(
            Stream.take(
              KeyPresses.make(["KeyR", "Escape"], (code) => code),
              2
            )
          )
        );
        yield* waitUntil(() => added.mock.calls.length > 0);
        keydown(window, "KeyR", true);
        keydown(window, "KeyX");
        keydown(window, "KeyR");
        keydown(window, "Escape");
        return yield* Fiber.join(fiber);
      })
    );
    expect(codes).toStrictEqual(["KeyR", "Escape"]);
    expect(removed).toHaveBeenCalledOnce();
  });

  it("reads the window when it runs, so it is made with no browser", async () => {
    vi.stubGlobal("window", undefined);
    const presses = KeyPresses.make(["KeyR"], (code) => code);
    const window = new EventTarget();
    vi.stubGlobal("window", window);
    const added = vi.spyOn(window, "addEventListener");
    const codes = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(presses, 1))
        );
        yield* waitUntil(() => added.mock.calls.length > 0);
        keydown(window, "KeyR");
        return yield* Fiber.join(fiber);
      })
    );
    expect(codes).toStrictEqual(["KeyR"]);
  });

  it("gives toMessage the code as one of the keys it was made for", () => {
    KeyPresses.make(["KeyR", "Escape"], (code) => {
      expectTypeOf(code).toEqualTypeOf<"KeyR" | "Escape">();
      // @ts-expect-error KeyX is none of the keys these presses are of.
      return code === "KeyX";
    });
    expectTypeOf(KeyPresses.make(["KeyR"], () => 1 as const)).toEqualTypeOf<
      Stream.Stream<1>
    >();
  });
});
