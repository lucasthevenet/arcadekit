import { Effect, Fiber, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShortcutPresses } from "./index";

// No DOM here: Node's EventTarget stands in for the window, and events are plain Events carrying
// the fields a shortcut's press reads.

let window: EventTarget;

const keydown = (code: string, fields: Record<string, unknown> = {}) => {
  const event = new Event("keydown");
  Object.defineProperty(event, "code", { value: code });
  for (const [key, value] of Object.entries({ repeat: false, ...fields })) {
    Object.defineProperty(event, key, { value });
  }
  window.dispatchEvent(event);
};

const waitUntil = (isDone: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 100 && !isDone(); turn++) {
      yield* Effect.yieldNow;
    }
  });

/** The codes of the first `count` shortcut presses of `codes`, once `press` has run. */
const firstPresses = (
  codes: readonly string[],
  count: number,
  press: () => void
) => {
  const added = vi.spyOn(window, "addEventListener");
  return Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(
          Stream.take(
            ShortcutPresses.make(codes, (code) => code),
            count
          )
        )
      );
      yield* waitUntil(() => added.mock.calls.length > 0);
      press();
      return yield* Fiber.join(fiber);
    })
  );
};

describe("ShortcutPresses.make", () => {
  beforeEach(() => {
    window = new EventTarget();
    vi.stubGlobal("window", window);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores presses with a modifier held or typed into a text field", async () => {
    const field = Object.assign(new EventTarget(), {
      tagName: "INPUT",
      type: "text",
    });
    const slider = Object.assign(new EventTarget(), {
      tagName: "INPUT",
      type: "range",
    });
    const codes = await firstPresses(["KeyM", "KeyN"], 2, () => {
      keydown("KeyM", { metaKey: true });
      keydown("KeyM", { ctrlKey: true });
      keydown("KeyM", { altKey: true });
      keydown("KeyM", { target: field });
      keydown("KeyN", { target: slider });
      keydown("KeyM");
    });
    expect(codes).toStrictEqual(["KeyN", "KeyM"]);
  });

  it("counts a press on a checkbox or with Shift held, and none into a textarea or editable content, nor a repeat", async () => {
    const textarea = Object.assign(new EventTarget(), { tagName: "TEXTAREA" });
    const editable = Object.assign(new EventTarget(), {
      tagName: "DIV",
      isContentEditable: true,
    });
    const checkbox = Object.assign(new EventTarget(), {
      tagName: "INPUT",
      type: "checkbox",
    });
    const codes = await firstPresses(["KeyM"], 2, () => {
      keydown("KeyM", { target: textarea });
      keydown("KeyM", { target: editable });
      keydown("KeyM", { repeat: true });
      keydown("KeyM", { target: checkbox });
      keydown("KeyM", { shiftKey: true });
    });
    expect(codes).toStrictEqual(["KeyM", "KeyM"]);
  });
});
