import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import * as Game from "../../game/index";
import * as Scenario from "../../game/scenario";
import {
  AnswerOffer,
  HoldPause,
  NothingOwed,
  OfferOpened,
  RunEnded,
  TestGame,
  manualTicker,
  testContent,
  testCoopParts,
} from "./index";
import type { Score, TestConfig, TestEvent, TestInput } from "./index";

// The test helpers' own rules: the test game's lockstep parts as values, its commands as
// scenarios, and the manual ticker.

const rules = testCoopParts();

/**
 * A run of the test game on a loop: its state, what it reported but its samples, its last
 * sample, and a step, which takes the 100 ms a sample is due after.
 */
const startRun = (config: TestConfig) => {
  const loop = new Game.Loop(TestGame);
  const reported: TestEvent[] = [];
  let sampled: Score | undefined;
  let nowMs = 0;
  loop.subscribe((event) => {
    if (event._tag === "Score") {
      sampled = event;
    } else {
      reported.push(event);
    }
  });
  loop.start(config, 1, nowMs);
  return {
    state: loop.state!,
    reported,
    /** Who still owes the open offer an answer, by slot, as the run's last sample says. */
    owes: () => sampled?.owes,
    stepAll: (
      players: readonly (TestInput | null)[],
      leaving: readonly number[] = []
    ) => {
      nowMs += 100;
      loop.frame({ read: () => ({ players, leaving }) }, { steps: 1 }, nowMs);
    },
    /** `slot`'s player answers offer 1: the next step applies it. */
    answer: (slot: number, value: number) => {
      loop.send(new AnswerOffer({ offer: 1, value }), slot);
    },
  };
};

/** Offer 1, as it opens for `slot`'s player. */
const offered = (slot: number) => new OfferOpened({ offer: 1, slot });

describe("the test game", () => {
  const content = { ...testContent, length: 5, offerEvery: 2 };
  const start = () => startRun(rules.config(content, ["red", "blue"]));

  it("lists its content's picks, and makes its config from the players' picks", () => {
    expect([
      rules.picks(content),
      rules.config(content, ["blue", "red"]),
    ]).toStrictEqual([
      ["red", "green", "blue"],
      { content, picks: ["blue", "red"] },
    ]);
  });

  it("is the declared simulation its lockstep parts run, with one player's input to send", () => {
    const decode = Schema.decodeUnknownResult(
      Game.playerInputSchema(rules.simulation)
    );
    expect([
      rules.simulation === TestGame,
      decode({ add: 1 }),
      Result.isFailure(decode({ add: "1" })),
    ]).toStrictEqual([true, Result.succeed({ add: 1 }), true]);
  });

  it("waits on an offer until each player answers it, and says in its sample who still owes one", () => {
    const { state, reported, owes, stepAll, answer } = start();
    stepAll([{ add: 1 }, { add: 2 }]);
    stepAll([{ add: 1 }, { add: 2 }]);
    const opened = [...reported];
    answer(1, 9);
    stepAll([{ add: 1 }, { add: 2 }]);
    const midway = [state.steps, owes()];
    answer(0, 4);
    stepAll([{ add: 1 }, { add: 2 }]);
    expect([
      opened,
      midway,
      state.steps,
      state.totals,
      state.bonus,
      owes(),
    ]).toStrictEqual([
      [
        new OfferOpened({ offer: 1, slot: 0 }),
        new OfferOpened({ offer: 1, slot: 1 }),
      ],
      [2, [true, false]],
      // The step that took the last answer played.
      3,
      [3, 6],
      [4, 9],
      [false, false],
    ]);
  });

  it("ends after its length, with every player's total, and names the event a run ends with", () => {
    const { state, reported, stepAll } = startRun(
      rules.config({ ...content, offerEvery: 0 }, ["red", "blue"])
    );
    for (let i = 0; i < 7; i++) {
      stepAll([{ add: 1 }, { add: 3 }], i === 2 ? [1] : []);
    }
    expect([
      state.steps,
      reported,
      reported.map((event) => rules.ends.has(event._tag)),
      rules.ends.has(offered(1)._tag),
    ]).toStrictEqual([5, [new RunEnded({ totals: [5, 6] })], [true], false]);
  });
});

describe("the test game's commands", () => {
  const scenario = Scenario.make(TestGame);
  const content = { ...testContent, length: 100, offerEvery: 2 };
  const config = { content, picks: ["red", "blue"] };
  const ones = { players: [{ add: 1 }, { add: 1 }], leaving: [] };

  /** Two steps of play: offer 1 opens for both players. */
  const untilOffered = [
    Scenario.given(config),
    Scenario.step(ones, 2),
    Scenario.reported(
      new OfferOpened({ offer: 1, slot: 0 }),
      new OfferOpened({ offer: 1, slot: 1 })
    ),
  ];

  it("takes each player's answer to the open offer, and plays on once both have answered", () =>
    scenario(
      untilOffered,
      Scenario.send(new AnswerOffer({ offer: 1, value: 4 })),
      Scenario.step(ones),
      Scenario.state((state) =>
        expect([state.bonus, state.owes, state.steps]).toStrictEqual([
          [4, 0],
          [false, true],
          2,
        ])
      ),
      Scenario.send(new AnswerOffer({ offer: 1, value: 9 }), 1),
      // Applied before the step, so the step that takes the last answer plays.
      Scenario.step(ones),
      Scenario.state((state) =>
        expect([state.bonus, state.owes, state.steps]).toStrictEqual([
          [4, 9],
          [false, false],
          3,
        ])
      ),
      Scenario.reported()
    ));

  it("refuses an answer to an offer its sender doesn't owe: another offer, none open, or answered already", () =>
    scenario(
      Scenario.given(config),
      Scenario.send(new AnswerOffer({ offer: 1, value: 1 })),
      Scenario.step(ones, 2),
      Scenario.refused(new NothingOwed({ offer: 1 })),
      Scenario.reported(
        new OfferOpened({ offer: 1, slot: 0 }),
        new OfferOpened({ offer: 1, slot: 1 })
      ),
      Scenario.send(new AnswerOffer({ offer: 2, value: 1 })),
      Scenario.send(new AnswerOffer({ offer: 1, value: 3 })),
      Scenario.send(new AnswerOffer({ offer: 1, value: 5 })),
      Scenario.step(ones),
      Scenario.refused(
        new NothingOwed({ offer: 2 }),
        new NothingOwed({ offer: 1 })
      ),
      Scenario.state((state) => expect(state.bonus).toStrictEqual([3, 0]))
    ));

  it("holds the run while a player holds the pause, until it lets go or leaves", () =>
    scenario(
      Scenario.given({
        content: { ...content, offerEvery: 0 },
        picks: config.picks,
      }),
      Scenario.send(new HoldPause({ held: true }), 1),
      Scenario.step(ones, 3),
      Scenario.state((state) =>
        expect([state.steps, state.held]).toStrictEqual([0, [false, true]])
      ),
      Scenario.send(new HoldPause({ held: false }), 1),
      Scenario.step(ones),
      Scenario.state((state) => expect(state.steps).toBe(1)),
      Scenario.send(new HoldPause({ held: true }), 1),
      Scenario.step(ones),
      // A player who leaves lets go of it in the step it leaves at.
      Scenario.step({ players: [{ add: 1 }, null], leaving: [1] }),
      Scenario.state((state) =>
        expect([state.steps, state.held]).toStrictEqual([2, [false, false]])
      )
    ));
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
