import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import * as Game from "../../game/index";
import {
  OfferOpened,
  RunEnded,
  TestGame,
  manualTicker,
  testContent,
  testCoopRules,
} from "./index";
import type { TestConfig, TestEvent, TestInput } from "./index";

// The test helpers' own rules, as values: the test game's lockstep parts and the manual ticker.

/** A run of the test game on a loop: its state, what it reported but its samples, and a step. */
const startRun = (config: TestConfig) => {
  const loop = new Game.Loop(TestGame);
  const reported: TestEvent[] = [];
  loop.subscribe((event) => {
    if (event._tag !== "Score") {
      reported.push(event);
    }
  });
  loop.start(config, 1, 0);
  return {
    state: loop.state!,
    reported,
    stepAll: (
      players: readonly (TestInput | null)[],
      leaving: readonly number[] = []
    ) => loop.frame({ read: () => ({ players, leaving }) }, { steps: 1 }, 0),
  };
};

/** Offer 1, as it opens for `slot`'s player. */
const offered = (slot: number) => new OfferOpened({ offer: 1, slot });

describe("the test game", () => {
  const content = { ...testContent, length: 5, offerEvery: 2 };
  const start = () => startRun(testCoopRules.config(content, ["red", "blue"]));

  it("lists its content's picks, and makes its config from the players' picks", () => {
    expect([
      testCoopRules.picks(content),
      testCoopRules.config(content, ["blue", "red"]),
    ]).toStrictEqual([
      ["red", "green", "blue"],
      { content, picks: ["blue", "red"] },
    ]);
  });

  it("is the declared simulation its lockstep parts run, with one player's input to send", () => {
    const decode = Schema.decodeUnknownResult(
      Game.playerInputSchema(testCoopRules.simulation)
    );
    expect([
      testCoopRules.simulation === TestGame,
      decode({ add: 1, answer: { offer: 1, value: 2 }, paused: true }),
      Result.isFailure(decode({ add: "1" })),
    ]).toStrictEqual([
      true,
      Result.succeed({ add: 1, answer: { offer: 1, value: 2 }, paused: true }),
      true,
    ]);
  });

  it("waits on an offer until each player answers it, and says who still owes one", () => {
    const { state, reported, stepAll } = start();
    stepAll([{ add: 1 }, { add: 2 }]);
    stepAll([{ add: 1 }, { add: 2 }]);
    const opened = [...reported];
    stepAll([{ add: 1 }, { add: 2, answer: { offer: 1, value: 9 } }]);
    const answer = { offer: 1, value: 4 };
    const midway = [
      state.steps,
      testCoopRules.choosing(state, 0),
      testCoopRules.choosing(state, 1),
      testCoopRules.settled(answer, state, 0),
      testCoopRules.settled(answer, state, 1),
      testCoopRules.settled({ offer: 2, value: 1 }, state, 0),
    ];
    stepAll([{ add: 1, answer }, { add: 2 }]);
    stepAll([{ add: 1 }, { add: 2 }]);
    expect([
      opened,
      midway,
      state.steps,
      state.totals,
      state.bonus,
    ]).toStrictEqual([
      [
        new OfferOpened({ offer: 1, slot: 0 }),
        new OfferOpened({ offer: 1, slot: 1 }),
      ],
      [2, true, false, false, true, true],
      3,
      [3, 6],
      [4, 9],
    ]);
  });

  it("ends after its length, and tells each player its own total", () => {
    const { state, reported, stepAll } = startRun(
      testCoopRules.config({ ...content, offerEvery: 0 }, ["red", "blue"])
    );
    for (let i = 0; i < 7; i++) {
      stepAll([{ add: 1 }, { add: 3 }], i === 2 ? [1] : []);
    }
    const [end] = reported;
    const names = ["Host", "Guest 1"];
    expect([
      state.steps,
      reported,
      end && testCoopRules.runEnded(end),
      end && testCoopRules.localEvent(end, 1, names),
      testCoopRules.localEvent(offered(0), 1, names),
      testCoopRules.localEvent(offered(1), 1, names),
      testCoopRules.runEnded(offered(1)),
    ]).toStrictEqual([
      5,
      [new RunEnded({ totals: [5, 6] })],
      true,
      { type: "ended", total: 6, names },
      null,
      { type: "offer", offer: 1 },
      false,
    ]);
  });

  it("holds the run while a player still in it pauses", () => {
    const { state, stepAll } = start();
    stepAll([{ add: 1, paused: true }, { add: 1 }]);
    const paused = state.steps;
    stepAll([{ add: 1 }, { add: 1 }]);
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
