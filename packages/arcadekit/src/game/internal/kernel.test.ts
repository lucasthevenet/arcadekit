import { describe, expect, it } from "vitest";

import type { StepInput } from "../step-input";
import { Kernel } from "./kernel";
import type { KernelSimulation } from "./kernel";

// The kernel needs no DOM and reads no clock: these tests pass time and input in, as the
// browser engine does each frame.

// A game that counts steps and how many of them saw a "just pressed" button.
interface PressState {
  steps: number;
  presses: number;
}

// 1/64 s steps: frame times below are exact in floating point.
const pressGame: KernelSimulation<null, PressState, boolean, PressState> = {
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
  const kernel = new Kernel(pressGame);
  const button = fakeButton(options);
  let last: PressState = { steps: 0, presses: 0 };
  kernel.subscribe((state) => {
    last = state;
  });
  kernel.start(null, 1, 0);
  return { kernel, button, read: () => last };
};

describe("button presses", () => {
  it("reaches one step of a frame that runs several, when reset in endStep", () => {
    const { kernel, button, read } = startPresses({ resetOn: "step" });
    button.press();
    // 62.5 ms is four steps.
    expect(kernel.frame(button.source, { seconds: 0.0625 }, 62.5)).toBe(4);
    expect(read()).toStrictEqual({ steps: 4, presses: 1 });
  });

  it("reaches every step of a frame, when reset only in endFrame", () => {
    const { kernel, button, read } = startPresses({ resetOn: "frame" });
    button.press();
    kernel.frame(button.source, { seconds: 0.0625 }, 62.5);
    expect(read()).toStrictEqual({ steps: 4, presses: 4 });
  });

  it("waits for the next step when a frame runs none", () => {
    const { kernel, button, read } = startPresses({ resetOn: "step" });
    button.press();
    // Less than one step: nothing runs, and the press must not be lost.
    kernel.frame(button.source, { seconds: 0.01 }, 10);
    kernel.frame(button.source, { seconds: 0.01 }, 20);
    kernel.frame(button.source, { seconds: 0.02 }, 40);
    expect(read()).toStrictEqual({ steps: 2, presses: 1 });
  });
});

/** A game whose every call, and every call to its input source and listener, goes into `log`. */
const loggingKernel = (log: string[]) => {
  let pending = 0;
  const kernel = new Kernel<null, { steps: number }, number, string>({
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
  kernel.subscribe((event) => log.push(event));
  const input: StepInput<number> = {
    read: (step) => {
      log.push(`read ${step}`);
      return step;
    },
    endStep: () => log.push("endStep"),
    endFrame: () => log.push("endFrame"),
  };
  return { kernel, input };
};

/** A game that counts its steps, with no input. */
const counterGame: KernelSimulation<null, { steps: number }, null, number> = {
  stepSeconds: 1 / 64,
  create: () => ({ steps: 0 }),
  step: (state) => {
    state.steps += 1;
  },
  drainEvents: () => [],
};

const noInput: StepInput<null> = { read: () => null };

describe(Kernel, () => {
  it("runs each step as read, step, endStep, then endFrame, events and a sample once per frame", () => {
    const log: string[] = [];
    const { kernel, input } = loggingKernel(log);
    kernel.start(null, 1, 0);
    kernel.frame(input, { steps: 2 }, 0);
    // Too short for a step: events and samples are checked, but no input is read.
    kernel.frame(input, { seconds: 0.001 }, 1);
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
    const kernel = new Kernel(counterGame);
    kernel.start(null, 1, 0);
    // Half a step of leftover time.
    expect(kernel.frame(noInput, { seconds: 1 / 128 }, 0)).toBe(0);
    expect(kernel.frame(noInput, { steps: 10 }, 0)).toBe(10);
    // The half step is gone: another half step still owes none.
    expect(kernel.frame(noInput, { seconds: 1 / 128 }, 0)).toBe(0);
    // Time is still clamped and capped at 5 steps.
    expect(kernel.frame(noInput, { seconds: 10 }, 0)).toBe(5);
    expect(kernel.stepIndex).toBe(15);
  });

  it("has no state and no steps after stop, and a new run counts its steps from 0", () => {
    const kernel = new Kernel(counterGame);
    kernel.start(null, 1, 0);
    kernel.frame(noInput, { steps: 3 }, 0);
    kernel.stop();
    expect([kernel.state, kernel.stepIndex]).toStrictEqual([null, 0]);
    expect(kernel.frame(noInput, { steps: 3 }, 0)).toBe(0);
    kernel.start(null, 1, 0);
    kernel.frame(noInput, { steps: 2 }, 0);
    expect(kernel.stepIndex).toBe(2);
  });

  it("runs nothing and calls no input with no run or while paused", () => {
    const log: string[] = [];
    const { kernel, input } = loggingKernel(log);
    expect(kernel.frame(input, { steps: 3 }, 0)).toBe(0);
    kernel.start(null, 1, 0);
    kernel.setPaused(true);
    expect(kernel.frame(input, { steps: 3 }, 0)).toBe(0);
    expect(kernel.frame(input, { seconds: 0.25 }, 250)).toBe(0);
    expect(kernel.stepIndex).toBe(0);
    expect(log).toStrictEqual(["sample 0"]);
  });

  it("counts everyMs on the time the caller passes in", () => {
    const kernel = new Kernel<null, { steps: number }, null, number>({
      ...counterGame,
      sample: { everyMs: 100, read: (state) => state.steps },
    });
    const samples: number[] = [];
    kernel.subscribe((steps) => samples.push(steps));
    kernel.start(null, 1, 0);
    for (let i = 1; i <= 30; i++) {
      kernel.frame(noInput, { steps: 1 }, i * 10);
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
  it("emits on start, then only right after a frame that changed the version", () => {
    const kernel = new Kernel<null, TurnState, null, string>({
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
    kernel.subscribe((sample) => samples.push(sample));
    kernel.start(null, 1, 0);
    // One step per frame (1/64 s = 15.625 ms): turns land on steps 3 and 6.
    for (let frame = 1; frame <= 7; frame++) {
      kernel.frame(noInput, { seconds: 1 / 64 }, frame * 15.625);
    }
    expect(samples).toStrictEqual([
      "turns 0 at step 0",
      "turns 1 at step 3",
      "turns 2 at step 6",
    ]);
  });
});
