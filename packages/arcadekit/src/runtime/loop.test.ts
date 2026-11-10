import { describe, expect, it } from "vitest";

import { GameLoop } from "./index";
import type { GameSimulation, StepInput } from "./index";

// GameLoop needs no DOM and reads no clock: these tests pass time and input in, as the
// browser engine does each frame.

// A game that counts steps and how many of them saw a "just pressed" button.
interface PressState {
  steps: number;
  presses: number;
}

// 1/64 s steps: frame times below are exact in floating point.
const pressGame: GameSimulation<null, PressState, boolean, PressState> = {
  stepSeconds: 1 / 64,
  create: () => ({ steps: 0, presses: 0 }),
  step: (state, pressed) => {
    state.steps += 1;
    if (pressed) {
      state.presses += 1;
    }
  },
  drainEvents: () => [],
  sample: { everyMs: 0, read: (state) => ({ ...state }) },
};

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
    } satisfies StepInput<boolean>,
  };
};

/** A started press game, with its button and the last sample it reported. */
const startPresses = (options: { readonly resetOn: "step" | "frame" }) => {
  const loop = new GameLoop(pressGame);
  const button = fakeButton(options);
  let last: PressState = { steps: 0, presses: 0 };
  loop.subscribe((state) => {
    last = state;
  });
  loop.start(null, 1, 0);
  return { loop, button, read: () => last };
};

describe("button presses", () => {
  it("reaches one step of a frame that runs several, when reset in endStep", () => {
    const { loop, button, read } = startPresses({ resetOn: "step" });
    button.press();
    // 62.5 ms is four steps.
    expect(loop.frame(button.source, { seconds: 0.0625 }, 62.5)).toBe(4);
    expect(read()).toStrictEqual({ steps: 4, presses: 1 });
  });

  it("reaches every step of a frame, when reset only in endFrame", () => {
    const { loop, button, read } = startPresses({ resetOn: "frame" });
    button.press();
    loop.frame(button.source, { seconds: 0.0625 }, 62.5);
    expect(read()).toStrictEqual({ steps: 4, presses: 4 });
  });

  it("waits for the next step when a frame runs none", () => {
    const { loop, button, read } = startPresses({ resetOn: "step" });
    button.press();
    // Less than one step: nothing runs, and the press must not be lost.
    loop.frame(button.source, { seconds: 0.01 }, 10);
    loop.frame(button.source, { seconds: 0.01 }, 20);
    loop.frame(button.source, { seconds: 0.02 }, 40);
    expect(read()).toStrictEqual({ steps: 2, presses: 1 });
  });
});

/** A game whose every call, and every call to its input source and listener, goes into `log`. */
const loggingLoop = (log: string[]) => {
  let pending = 0;
  const loop = new GameLoop<null, { steps: number }, number, string>({
    stepSeconds: 1 / 64,
    create: () => ({ steps: 0 }),
    step: (state, input) => {
      log.push(`step ${input}`);
      state.steps += 1;
      pending += 1;
    },
    drainEvents: (state) => {
      const events = pending > 0 ? [`events after ${state.steps}`] : [];
      pending = 0;
      return events;
    },
    sample: {
      version: (state) => state.steps,
      read: (state) => `sample ${state.steps}`,
    },
  });
  loop.subscribe((event) => log.push(event));
  const input: StepInput<number> = {
    read: (step) => {
      log.push(`read ${step}`);
      return step;
    },
    endStep: () => log.push("endStep"),
    endFrame: () => log.push("endFrame"),
  };
  return { loop, input };
};

/** A game that counts its steps, with no input. */
const counterGame: GameSimulation<null, { steps: number }, null, number> = {
  stepSeconds: 1 / 64,
  create: () => ({ steps: 0 }),
  step: (state) => {
    state.steps += 1;
  },
  drainEvents: () => [],
};

const noInput: StepInput<null> = { read: () => null };

describe(GameLoop, () => {
  it("runs each step as read, step, endStep, then endFrame, events and a sample once per frame", () => {
    const log: string[] = [];
    const { loop, input } = loggingLoop(log);
    loop.start(null, 1, 0);
    loop.frame(input, { steps: 2 }, 0);
    // Too short for a step: events and samples are checked, but no input is read.
    loop.frame(input, { seconds: 0.001 }, 1);
    expect(log).toStrictEqual([
      "sample 0",
      "read 0",
      "step 0",
      "endStep",
      "read 1",
      "step 1",
      "endStep",
      "endFrame",
      "events after 2",
      "sample 2",
    ]);
  });

  it("runs exactly the steps asked for, past the cap, and clears the clock's leftover time", () => {
    const loop = new GameLoop(counterGame);
    loop.start(null, 1, 0);
    // Half a step of leftover time.
    expect(loop.frame(noInput, { seconds: 1 / 128 }, 0)).toBe(0);
    expect(loop.frame(noInput, { steps: 10 }, 0)).toBe(10);
    // The half step is gone: another half step still owes none.
    expect(loop.frame(noInput, { seconds: 1 / 128 }, 0)).toBe(0);
    // Time is still clamped and capped at 5 steps.
    expect(loop.frame(noInput, { seconds: 10 }, 0)).toBe(5);
    expect(loop.stepIndex).toBe(15);
  });

  it("runs nothing and calls no input with no run or while paused", () => {
    const log: string[] = [];
    const { loop, input } = loggingLoop(log);
    expect(loop.frame(input, { steps: 3 }, 0)).toBe(0);
    loop.start(null, 1, 0);
    loop.setPaused(true);
    expect(loop.frame(input, { steps: 3 }, 0)).toBe(0);
    expect(loop.frame(input, { seconds: 0.25 }, 250)).toBe(0);
    expect(loop.stepIndex).toBe(0);
    expect(log).toStrictEqual(["sample 0"]);
  });

  it("counts everyMs on the time the caller passes in", () => {
    const loop = new GameLoop<null, { steps: number }, null, number>({
      ...counterGame,
      sample: { everyMs: 100, read: (state) => state.steps },
    });
    const samples: number[] = [];
    loop.subscribe((steps) => samples.push(steps));
    loop.start(null, 1, 0);
    for (let i = 1; i <= 30; i++) {
      loop.frame(noInput, { steps: 1 }, i * 10);
    }
    expect(samples).toStrictEqual([0, 10, 20, 30]);
  });
});

// A turn-based counter: the step makes a "turn" every third step.
interface TurnState {
  steps: number;
  turns: number;
}

describe("sample with a version", () => {
  it("emits on start, then only right after a frame or modify that changed the version", () => {
    const loop = new GameLoop<null, TurnState, null, string>({
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
    });
    const samples: string[] = [];
    loop.subscribe((sample) => samples.push(sample));
    loop.start(null, 1, 0);
    // One step per frame (1/64 s = 15.625 ms): turns land on steps 3 and 6.
    for (let frame = 1; frame <= 7; frame++) {
      loop.frame(noInput, { seconds: 1 / 64 }, frame * 15.625);
    }
    loop.modify((state) => {
      state.steps = 100;
    }, 120);
    loop.modify((state) => {
      state.turns = 10;
    }, 130);
    expect(samples).toStrictEqual([
      "turns 0 at step 0",
      "turns 1 at step 3",
      "turns 2 at step 6",
      "turns 10 at step 100",
    ]);
  });
});
