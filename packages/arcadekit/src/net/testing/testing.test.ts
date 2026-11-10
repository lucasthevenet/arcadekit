import { describe, expect, it } from "vitest";

import { manualTicker, testContent, testCoopRules } from "./index";
import type { TestState } from "./index";

// The test helpers' own rules, as values: the test game's lockstep parts and the manual ticker.

const { simulation } = testCoopRules;

const stepAll = (
  state: TestState,
  players: readonly Parameters<typeof simulation.step>[1]["players"][number][],
  leaving: readonly number[] = []
) => simulation.step(state, { players, leaving }, 1 / 60);

describe("the test game", () => {
  const content = { ...testContent, length: 5, offerEvery: 2 };
  const start = () =>
    simulation.create(testCoopRules.config(content, ["red", "blue"]), 1);

  it("lists its content's picks, and makes its config from the players' picks", () => {
    expect([
      testCoopRules.picks(content),
      testCoopRules.config(content, ["blue", "red"]),
    ]).toStrictEqual([
      ["red", "green", "blue"],
      { content, picks: ["blue", "red"] },
    ]);
  });

  it("waits on an offer until each player answers it, and says who still owes one", () => {
    const state = start();
    stepAll(state, [{ add: 1 }, { add: 2 }]);
    stepAll(state, [{ add: 1 }, { add: 2 }]);
    const opened = simulation.drainEvents(state);
    stepAll(state, [{ add: 1 }, { add: 2, answer: { offer: 1, value: 9 } }]);
    const answer = { offer: 1, value: 4 };
    const midway = [
      state.steps,
      testCoopRules.choosing(state, 0),
      testCoopRules.choosing(state, 1),
      testCoopRules.settled(answer, state, 0),
      testCoopRules.settled(answer, state, 1),
      testCoopRules.settled({ offer: 2, value: 1 }, state, 0),
    ];
    stepAll(state, [{ add: 1, answer }, { add: 2 }]);
    stepAll(state, [{ add: 1 }, { add: 2 }]);
    expect([
      opened,
      midway,
      state.steps,
      state.totals,
      state.bonus,
    ]).toStrictEqual([
      [
        { type: "offer", offer: 1, slot: 0 },
        { type: "offer", offer: 1, slot: 1 },
      ],
      [2, true, false, false, true, true],
      3,
      [3, 6],
      [4, 9],
    ]);
  });

  it("ends after its length, and tells each player its own total", () => {
    const state = simulation.create(
      testCoopRules.config({ ...content, offerEvery: 0 }, ["red", "blue"]),
      1
    );
    for (let i = 0; i < 7; i++) {
      stepAll(state, [{ add: 1 }, { add: 3 }], i === 2 ? [1] : []);
    }
    const [end] = simulation.drainEvents(state);
    const names = ["Host", "Guest 1"];
    expect([
      state.steps,
      end,
      end && testCoopRules.runEnded(end),
      end && testCoopRules.localEvent(end, 1, names),
      testCoopRules.localEvent({ type: "offer", offer: 1, slot: 0 }, 1, names),
      testCoopRules.localEvent({ type: "offer", offer: 1, slot: 1 }, 1, names),
      testCoopRules.runEnded({ type: "offer", offer: 1, slot: 1 }),
    ]).toStrictEqual([
      5,
      { type: "ended", totals: [5, 6] },
      true,
      { type: "ended", total: 6, names },
      null,
      { type: "offer", offer: 1 },
      false,
    ]);
  });

  it("holds the run while a player still in it pauses", () => {
    const state = start();
    stepAll(state, [{ add: 1, paused: true }, { add: 1 }]);
    const paused = state.steps;
    stepAll(state, [{ add: 1 }, { add: 1 }]);
    expect([paused, state.steps]).toStrictEqual([0, 1]);
  });

  it("fills one input object with the device, the answer and the pause", () => {
    const fill = testCoopRules.localInput();
    const answer = { offer: 1, value: 2 };
    const first = fill({ add: 3 }, answer, true);
    const copy = { ...first };
    const second = fill(null, null, false);
    expect([copy, second, second === first]).toStrictEqual([
      { add: 3, answer, paused: true },
      { add: 0 },
      true,
    ]);
  });
});

describe(manualTicker, () => {
  it("ticks each run it was started for, until that run stops", () => {
    const manual = manualTicker();
    const ticks: string[] = [];
    const stopA = manual.ticker(() => ticks.push("a"));
    const stopB = manual.ticker(() => ticks.push("b"));
    manual.tick();
    stopA();
    manual.tick();
    const ticking = manual.ticking();
    stopB();
    manual.tick();
    expect([ticks, ticking, manual.ticking()]).toStrictEqual([
      ["a", "b", "b"],
      1,
      0,
    ]);
  });
});
