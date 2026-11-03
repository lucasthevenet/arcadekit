import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GameDriver, makeGameEngine } from "./index";
import type { GameDefinition } from "./index";

// A tiny game: a counter that reports when it is bumped past a threshold.
interface State {
  value: number;
  seed: number;
  events: string[];
}

const counterGame: GameDefinition<{ start: number }, State, number, string> = {
  create: ({ start }, seed) => ({
    value: start,
    seed,
    events: [`started at ${start}`],
  }),
  step: (state, input) => {
    state.value += input;
  },
  drainEvents: (state) => state.events.splice(0),
  sample: { everyMs: 100, read: (state) => `value ${state.value}` },
  createInput: () => ({ read: () => 1, dispose: () => {} }),
  createView: () => ({ render: () => {}, dispose: () => {} }),
};

const collect = (
  run: (
    engine: ReturnType<
      typeof makeGameEngine<{ start: number }, State, number, string>
    >
  ) => Effect.Effect<void>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engine = makeGameEngine(counterGame);
        const events: string[] = [];
        yield* engine.listen((event) => events.push(event));
        yield* run(engine);
        return events;
      })
    )
  );

describe(makeGameEngine, () => {
  it("reports creation events and a first sample when a run starts", async () => {
    const events = await collect((engine) => engine.start({ start: 5 }, 42));
    expect(events).toStrictEqual(["started at 5", "value 5"]);
  });

  it("reports events produced by modify", async () => {
    const events = await collect((engine) =>
      Effect.gen(function* () {
        yield* engine.start({ start: 0 }, 1);
        yield* engine.modify((state) => {
          state.value = 10;
          state.events.push("jumped to 10");
        });
      })
    );
    expect(events).toStrictEqual(["started at 0", "value 0", "jumped to 10"]);
  });

  it("ignores modify when no run is active", async () => {
    let called = false;
    const events = await collect((engine) =>
      engine.modify(() => {
        called = true;
      })
    );
    expect(called).toBe(false);
    expect(events).toStrictEqual([]);
  });

  it("stops reporting to a listener once its scope closes", async () => {
    const engine = makeGameEngine(counterGame);
    const events: string[] = [];
    await Effect.runPromise(
      Effect.scoped(engine.listen((event) => events.push(event)))
    );
    await Effect.runPromise(engine.start({ start: 1 }, 1));
    expect(events).toStrictEqual([]);
  });
});

// A game that counts steps and how many of them saw a "just pressed" button.
interface PressState {
  steps: number;
  presses: number;
}

/**
 * A one-button input source. Plain, it works like InputController: a press stays visible
 * until `endFrame`. With `reportOnce`, it reports each press to one `read` only, which is how
 * push-puzzle's input source keeps one press to one turn.
 */
const fakeButton = ({ reportOnce }: { readonly reportOnce: boolean }) => {
  let pressed = false;
  let reported = false;
  return {
    press: () => {
      pressed = true;
    },
    source: {
      read: () => {
        if (reportOnce && reported) {
          return false;
        }
        reported = pressed;
        return pressed;
      },
      endFrame: () => {
        pressed = false;
        reported = false;
      },
      dispose: () => {},
    },
  };
};

/** Replaces requestAnimationFrame so a test decides when frames run and how long they took. */
const manualFrames = () => {
  let pending: FrameRequestCallback | null = null;
  vi.spyOn(performance, "now").mockReturnValue(0);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    pending = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    pending = null;
  });
  return {
    runFrameAt: (nowMs: number) => {
      const callback = pending;
      pending = null;
      callback?.(nowMs);
    },
  };
};

// 1/64 s steps: frame times below are exact in floating point.
const pressGame = (button: ReturnType<typeof fakeButton>) =>
  ({
    stepSeconds: 1 / 64,
    create: () => ({ steps: 0, presses: 0 }),
    step: (state, pressed) => {
      state.steps += 1;
      if (pressed) {
        state.presses += 1;
      }
    },
    drainEvents: () => [],
    sample: { everyMs: 0, read: (state) => state },
    createInput: () => button.source,
    createView: () => ({ render: () => {}, dispose: () => {} }),
  }) satisfies GameDefinition<null, PressState, boolean, PressState>;

const setUp = (options: { readonly reportOnce: boolean }) => {
  const frames = manualFrames();
  const button = fakeButton(options);
  const driver = new GameDriver(pressGame(button));
  let last: PressState = { steps: 0, presses: 0 };
  driver.subscribe((state) => {
    last = { ...state };
  });
  const detach = driver.attach({} as HTMLElement);
  driver.start(null, 1);
  return { frames, button, detach, read: () => last };
};

describe("button presses", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // The runtime resets presses once per frame (InputSource.endFrame), so a press reaches
  // every step of a catch-up frame. Changing that changes the GameDefinition contract:
  // see docs/push-puzzle-findings.md, finding 1.
  it("reaches every step of a frame that runs several", () => {
    const { frames, button, detach, read } = setUp({ reportOnce: false });
    button.press();
    // 62.5 ms is four steps.
    frames.runFrameAt(62.5);
    detach();
    expect(read()).toStrictEqual({ steps: 4, presses: 4 });
  });

  it("reaches one step when the input source reports each press once", () => {
    const { frames, button, detach, read } = setUp({ reportOnce: true });
    button.press();
    frames.runFrameAt(62.5);
    detach();
    expect(read()).toStrictEqual({ steps: 4, presses: 1 });
  });

  it("waits for the next step when a frame runs none", () => {
    const { frames, button, detach, read } = setUp({ reportOnce: false });
    button.press();
    // Less than one step: nothing runs, and the press must not be lost.
    frames.runFrameAt(10);
    frames.runFrameAt(20);
    frames.runFrameAt(40);
    detach();
    expect(read()).toStrictEqual({ steps: 2, presses: 1 });
  });
});
