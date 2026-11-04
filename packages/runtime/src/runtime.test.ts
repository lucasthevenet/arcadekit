import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GameDriver, makeGameEngine } from "./browser";
import type { GameDefinition } from "./browser";

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
 * A one-button input source that works like InputController: a press stays visible until
 * it is reset. It resets in `endStep` (as push-puzzle does, via `consumePresses`) or only in
 * `endFrame` (as a source that reads held state only can).
 */
const fakeButton = ({ resetOn }: { readonly resetOn: "step" | "frame" }) => {
  let pressed = false;
  const reset = () => {
    pressed = false;
  };
  return {
    press: () => {
      pressed = true;
    },
    source: {
      read: () => pressed,
      ...(resetOn === "step" ? { endStep: reset } : { endFrame: reset }),
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

const setUp = (options: { readonly resetOn: "step" | "frame" }) => {
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

  it("reaches one step of a frame that runs several, when reset in endStep", () => {
    const { frames, button, detach, read } = setUp({ resetOn: "step" });
    button.press();
    // 62.5 ms is four steps.
    frames.runFrameAt(62.5);
    detach();
    expect(read()).toStrictEqual({ steps: 4, presses: 1 });
  });

  it("reaches every step of a frame, when reset only in endFrame", () => {
    const { frames, button, detach, read } = setUp({ resetOn: "frame" });
    button.press();
    frames.runFrameAt(62.5);
    detach();
    expect(read()).toStrictEqual({ steps: 4, presses: 4 });
  });

  it("calls endStep after every step and endFrame once per frame that stepped", () => {
    const frames = manualFrames();
    const calls: string[] = [];
    const driver = new GameDriver({
      ...pressGame(fakeButton({ resetOn: "step" })),
      step: () => calls.push("step"),
      createInput: () => ({
        read: () => false,
        endStep: () => calls.push("endStep"),
        endFrame: () => calls.push("endFrame"),
        dispose: () => {},
      }),
    });
    const detach = driver.attach({} as HTMLElement);
    driver.start(null, 1);
    // Two steps, then a frame too short for any.
    frames.runFrameAt(31.25);
    frames.runFrameAt(35);
    detach();
    expect(calls).toStrictEqual([
      "step",
      "endStep",
      "step",
      "endStep",
      "endFrame",
    ]);
  });

  it("waits for the next step when a frame runs none", () => {
    const { frames, button, detach, read } = setUp({ resetOn: "step" });
    button.press();
    // Less than one step: nothing runs, and the press must not be lost.
    frames.runFrameAt(10);
    frames.runFrameAt(20);
    frames.runFrameAt(40);
    detach();
    expect(read()).toStrictEqual({ steps: 2, presses: 1 });
  });
});

describe("sample with a version", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // A turn-based counter: the step makes a "turn" every third step.
  interface TurnState {
    steps: number;
    turns: number;
  }

  it("emits on start, then only right after a frame or modify that changed the version", () => {
    const frames = manualFrames();
    const driver = new GameDriver<null, TurnState, null, string>({
      stepSeconds: 1 / 64,
      create: () => ({ steps: 0, turns: 0 }),
      step: (state) => {
        state.steps += 1;
        if (state.steps % 3 === 0) {
          state.turns += 1;
        }
      },
      drainEvents: () => [],
      sample: {
        version: (state) => state.turns,
        read: (state) => `turns ${state.turns} at step ${state.steps}`,
      },
      createInput: () => ({ read: () => null, dispose: () => {} }),
      createView: () => ({ render: () => {}, dispose: () => {} }),
    });
    const samples: string[] = [];
    driver.subscribe((sample) => samples.push(sample));
    const detach = driver.attach({} as HTMLElement);
    driver.start(null, 1);
    // One step per frame (1/64 s = 15.625 ms): turns land on steps 3 and 6.
    for (let frame = 1; frame <= 7; frame++) {
      frames.runFrameAt(frame * 15.625);
    }
    driver.modify((state) => {
      state.steps = 100;
    });
    driver.modify((state) => {
      state.turns = 10;
    });
    detach();
    expect(samples).toStrictEqual([
      "turns 0 at step 0",
      "turns 1 at step 3",
      "turns 2 at step 6",
      "turns 10 at step 100",
    ]);
  });
});
