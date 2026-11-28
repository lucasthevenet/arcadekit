import { describe, expect, it } from "vitest";

import { ENOUGH } from "../bench/checkouts.ts";
import {
  CHANCE,
  FLOOR,
  chance,
  failures,
  judge,
  judgeAll,
  onPurpose,
  pairChance,
  settled,
  settledAll,
  table,
} from "../bench/verdict.ts";
import type { Line } from "../bench/verdict.ts";
import { Rng } from "../src/ecs/random.ts";

/**
 * Runs as a shared machine gives them: most within a few in a hundred of
 * the build's own speed, and one in six half as slow again or worse.
 */
const runsOf = (random: Rng, speed: number, count: number): number[] =>
  Array.from(
    { length: count },
    () =>
      speed *
      (1 + 0.04 * random.next()) *
      (random.next() < 1 / 6 ? 1.5 + random.next() : 1)
  );

describe("how often by chance", () => {
  it("is the share of the deals in which that many runs of one hand beat all of the other's", () => {
    // Every way of dealing the runs 1 to n into two hands, counted.
    const counted = (
      beaten: number,
      winners: number,
      losers: number
    ): number => {
      const size = winners + losers;
      let deals = 0;
      let extreme = 0;
      for (let mask = 0; mask < 1 << size; mask++) {
        const first: number[] = [];
        const second: number[] = [];
        for (let run = 0; run < size; run++) {
          (((mask >> run) & 1) === 1 ? first : second).push(run);
        }
        if (first.length !== winners) {
          continue;
        }
        deals++;
        const best = Math.min(...second);
        if (first.filter((run) => run < best).length >= beaten) {
          extreme++;
        }
      }
      return extreme / deals;
    };
    for (const [winners, losers] of [
      [4, 4],
      [5, 5],
      [6, 3],
      [3, 7],
    ] as const) {
      for (let beaten = 0; beaten <= winners; beaten++) {
        expect(
          chance(beaten, winners, losers),
          `${beaten} of ${winners}`
        ).toBeCloseTo(counted(beaten, winners, losers), 12);
      }
    }
  });

  it("is under one in a thousand from nine of fifteen runs on, and not before", () => {
    expect(chance(8, 15, 15)).toBeGreaterThan(CHANCE);
    expect(chance(9, 15, 15)).toBeLessThan(CHANCE);
    // Every run of one build faster than every run of the other.
    expect(chance(15, 15, 15)).toBeCloseTo(1 / 155_117_520, 15);
    expect(chance(0, 15, 15)).toBe(1);
  });
});

describe("the verdict on a variant", () => {
  it("is slower when the head's fastest run is beaten by enough of the base's, and by more than the floor", () => {
    const random = new Rng(1);
    const verdict = judge(runsOf(random, 100, 15), runsOf(random, 115, 15));
    expect(verdict.outcome).toBe("slower");
    expect(verdict.ratio).toBeGreaterThan(1.1);
    expect(verdict.ratio).toBeLessThan(1.2);
    expect(verdict.of).toBe(15);
    expect(verdict.beaten).toBeGreaterThanOrEqual(9);
    expect(verdict.chance).toBeLessThanOrEqual(CHANCE);
  });

  it("is faster the other way round, and counts the head's runs then", () => {
    const base = [10, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8];
    const head = [8, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 20];
    expect(judge(base, head)).toEqual({
      outcome: "faster",
      ratio: 0.8,
      base: 10,
      head: 8,
      beaten: 8,
      of: 9,
      chance: chance(8, 9, 9),
    });
    // And is slower with the two changed over, by as much.
    expect(judge(head, base)).toEqual({
      outcome: "slower",
      ratio: 1.25,
      base: 8,
      head: 10,
      beaten: 8,
      of: 9,
      chance: chance(8, 9, 9),
    });
  });

  it("counts the hands as they are when the builds were run a different number of times", () => {
    // Five runs of one build and nine of the other.
    const few = [10, 10.1, 10.2, 10.3, 10.4];
    const many = [8, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8];
    expect(judge(few, many)).toMatchObject({
      outcome: "faster",
      beaten: 9,
      of: 9,
      chance: chance(9, 9, 5),
    });
    expect(judge(many, few)).toMatchObject({
      outcome: "slower",
      beaten: 9,
      of: 9,
      chance: chance(9, 9, 5),
    });
    expect(chance(9, 9, 5)).toBeCloseTo(1 / 2002, 12);
    expect(chance(9, 9, 9)).toBeCloseTo(1 / 48_620, 12);
    // Five against nine can be plain, and nine against five too.
    expect(
      judge(
        many,
        few.map((run) => run * 3)
      ).chance
    ).toBeLessThan(CHANCE);
  });

  it("is held to a twentieth and to one in a thousand, as its comment says", () => {
    expect(FLOOR).toBe(0.05);
    expect(CHANCE).toBe(0.001);
  });

  it("is the same when the runs are apart by less than the floor, however plainly", () => {
    const base = Array.from({ length: 15 }, (_, i) => 100 + i / 100);
    const within = base.map((run) => run * (1 + FLOOR) - 0.5);
    const beyond = base.map((run) => run * (1 + FLOOR) + 0.5);
    expect(judge(base, within).outcome).toBe("the same");
    expect(judge(base, within).chance).toBeLessThan(CHANCE);
    expect(judge(base, beyond).outcome).toBe("slower");
    expect(judge(within, base).outcome).toBe("the same");
    expect(judge(beyond, base).outcome).toBe("faster");
  });

  it("is the same when too few of the base's runs beat the head's fastest, however far apart the fastest are", () => {
    // One run of the base was lucky; the rest are where the head's are.
    const head = Array.from({ length: 15 }, (_, i) => 120 + i);
    const base = [100, ...Array.from({ length: 14 }, (_, i) => 125 + i)];
    const verdict = judge(base, head);
    expect(verdict.ratio).toBe(1.2);
    expect(verdict.beaten).toBe(1);
    expect(verdict.outcome).toBe("the same");
    // Eight of fifteen is not enough, and nine is.
    const eight = [...Array.from({ length: 8 }, () => 100), ...head.slice(8)];
    const nine = [...Array.from({ length: 9 }, () => 100), ...head.slice(9)];
    expect(judge(eight, head).outcome).toBe("the same");
    expect(judge(nine, head).outcome).toBe("slower");
  });

  it("does not count a run that is only as fast as the head's fastest", () => {
    const head = Array.from({ length: 9 }, () => 110);
    expect(
      judge(
        Array.from({ length: 9 }, () => 110),
        head
      ).beaten
    ).toBe(0);
    expect(
      judge(
        Array.from({ length: 9 }, () => 100),
        head
      ).beaten
    ).toBe(9);
  });

  it("is slower on purpose when a commit names the variant, and only when it is slower", () => {
    const base = Array.from({ length: 15 }, (_, i) => 100 + i / 10);
    const slow = base.map((run) => run * 1.2);
    expect(judge(base, slow, true).outcome).toBe("slower on purpose");
    expect(judge(base, base, true).outcome).toBe("the same");
    expect(judge(slow, base, true).outcome).toBe("faster");
  });

  it("is new when the base could not run the variant, and refuses to judge no run at all", () => {
    expect(judge([], [3, 2, 4])).toMatchObject({ outcome: "new", head: 2 });
    expect(() => judge([1, 2], [])).toThrow("no run of the head");
  });

  it("calls two builds that are the same slower less than once in a thousand comparisons, on a machine that disturbs one run in six", () => {
    const random = new Rng(7);
    let slower = 0;
    let faster = 0;
    const comparisons = 20_000;
    for (let i = 0; i < comparisons; i++) {
      const { outcome } = judge(
        runsOf(random, 100, 15),
        runsOf(random, 100, 15)
      );
      slower += outcome === "slower" ? 1 : 0;
      faster += outcome === "faster" ? 1 : 0;
    }
    // Twenty are allowed by the rule's own arithmetic, and the floor leaves
    // fewer: forty would be one comparison in five hundred.
    expect(slower).toBeLessThan(40);
    expect(faster).toBeLessThan(40);
  });

  it("finds a slowdown of a seventh nine times in ten on that machine, with fifteen runs each", () => {
    const random = new Rng(11);
    let found = 0;
    const comparisons = 2000;
    for (let i = 0; i < comparisons; i++) {
      found +=
        judge(runsOf(random, 100, 15), runsOf(random, 115, 15)).outcome ===
        "slower"
          ? 1
          : 0;
    }
    expect(found / comparisons).toBeGreaterThan(0.9);
  });
});

/**
 * Thirty runs whose fastest, first quartile and median are as given, spread
 * evenly between them and as far above the median as below it: issue
 * #450's table gives no more of them.
 */
const thirty = (fastest: number, quartile: number, middle: number) => {
  const lower = Array.from({ length: 15 }, (_, i) =>
    i <= 7
      ? fastest + ((quartile - fastest) * i) / 7
      : quartile + ((middle - quartile) * (i - 7)) / 7.5
  );
  return [...lower, ...lower.map((run) => 2 * middle - run)];
};

describe("how often by chance, pair by pair", () => {
  it("is the share of the deals in which one hand's run is the faster in that many pairs", () => {
    // Every way of dealing the runs 1 to n into two hands, counted.
    const counted = (pairs: number, winners: number, losers: number) => {
      const size = winners + losers;
      let deals = 0;
      let extreme = 0;
      for (let mask = 0; mask < 1 << size; mask++) {
        const first: number[] = [];
        const second: number[] = [];
        for (let run = 0; run < size; run++) {
          (((mask >> run) & 1) === 1 ? first : second).push(run);
        }
        if (first.length !== winners) {
          continue;
        }
        deals++;
        let won = 0;
        for (const run of first) {
          won += second.filter((other) => run < other).length;
        }
        extreme += won >= pairs ? 1 : 0;
      }
      return extreme / deals;
    };
    for (const [winners, losers] of [
      [4, 4],
      [5, 5],
      [6, 3],
      [3, 7],
    ] as const) {
      for (let pairs = 0; pairs <= winners * losers + 1; pairs++) {
        expect(
          pairChance(pairs, winners, losers),
          `${pairs} of ${winners * losers}`
        ).toBeCloseTo(counted(pairs, winners, losers), 12);
      }
    }
  });

  it("is one in as many deals as there are when every pair goes one way", () => {
    expect(pairChance(400, 20, 20)).toBeCloseTo(1 / 137_846_528_820, 20);
    expect(pairChance(0, 20, 20)).toBeCloseTo(1, 12);
    expect(pairChance(399.5, 20, 20)).toBe(pairChance(399, 20, 20));
  });
});

describe("the verdict on a variant by every run", () => {
  it("is slower where the medians moved and the fastest runs did not, as in issue #450's table", () => {
    // 4d05201 against 4f1d989: fastest, first quartile and median of 30
    // runs each, in ns per entity.
    const position = [thirty(24, 31.3, 32.3), thirty(25, 34.7, 37.9)];
    const flat = [thirty(19.2, 25.2, 26.6), thirty(21.1, 31.7, 38)];
    const flatAll = [thirty(72.5, 93.4, 96.2), thirty(70.3, 97.8, 117.8)];
    const all = [thirty(66.2, 91.3, 93.8), thirty(67.9, 90.7, 97.2)];
    for (const [base, head] of [position, flat, flatAll]) {
      expect(judge(base!, head!).outcome).toBe("the same");
      expect(judgeAll(base!, head!).outcome).toBe("slower");
    }
    expect(judgeAll(all[0]!, all[1]!)).toMatchObject({ outcome: "the same" });
    expect(judgeAll(all[0]!, all[1]!).ratio).toBeLessThan(1 + FLOOR);
  });

  it("finds a slowdown of most runs that leaves the fastest where it was", () => {
    const base = Array.from({ length: 20 }, (_, i) => 100 + i / 10);
    const head = base.map((run, i) => (i < 2 ? run : run * 1.2));
    expect(judge(base, head).outcome).toBe("the same");
    expect(judgeAll(base, head).outcome).toBe("slower");
  });

  it("is faster the other way round, the same within the floor, and slower on purpose when a commit says so", () => {
    const base = Array.from({ length: 20 }, (_, i) => 100 + i / 10);
    const quick = base.map((run) => run * 0.8);
    expect(judgeAll(base, quick)).toMatchObject({
      outcome: "faster",
      beaten: 400,
      of: 400,
      chance: pairChance(400, 20, 20),
    });
    expect(judgeAll(base, quick).ratio).toBeCloseTo(0.8, 12);
    expect(judgeAll(quick, base, true).outcome).toBe("slower on purpose");
    const within = base.map((run) => run * (1 + FLOOR) - 0.5);
    expect(judgeAll(base, within).chance).toBeLessThan(CHANCE);
    expect(judgeAll(base, within).outcome).toBe("the same");
  });

  it("is new when the base could not run the variant, and refuses to judge no run at all", () => {
    expect(judgeAll([], [3, 2, 4])).toMatchObject({ outcome: "new", head: 3 });
    expect(() => judgeAll([1, 2], [])).toThrow("no run of the head");
  });

  it("calls two builds that are the same slower less than once in a thousand comparisons, on a machine that disturbs one run in six", () => {
    const random = new Rng(7);
    let slower = 0;
    let faster = 0;
    const comparisons = 20_000;
    for (let i = 0; i < comparisons; i++) {
      const { outcome } = judgeAll(
        runsOf(random, 100, 30),
        runsOf(random, 100, 30)
      );
      slower += outcome === "slower" ? 1 : 0;
      faster += outcome === "faster" ? 1 : 0;
    }
    expect(slower).toBeLessThan(40);
    expect(faster).toBeLessThan(40);
  });

  it("finds a slowdown of a fourteenth nine times in ten on that machine, with thirty runs each", () => {
    const random = new Rng(11);
    let found = 0;
    const comparisons = 2000;
    for (let i = 0; i < comparisons; i++) {
      found +=
        judgeAll(runsOf(random, 100, 30), runsOf(random, 107, 30)).outcome ===
        "slower"
          ? 1
          : 0;
    }
    expect(found / comparisons).toBeGreaterThan(0.9);
  });
});

describe("a variant that need not be run again", () => {
  it("is one whose fastest runs are within half the floor, with runs of both builds in", () => {
    expect(settled([100, 130], [102, 101])).toBe(true);
    expect(settled([100, 130], [100 * (1 + FLOOR / 2) + 0.1, 140])).toBe(false);
    // Nor is one whose head is plainly faster: it is run on, to say so.
    expect(settled([100, 130], [80, 90])).toBe(false);
    expect(settled([100, 130], [100 / (1 + FLOOR / 2) + 0.1, 120])).toBe(true);
    expect(settled([], [80])).toBe(false);
    expect(settled([80], [])).toBe(false);
  });

  it("is, for the rule of every run, one whose medians are within half the floor", () => {
    expect(settledAll([100, 101, 140], [102, 103, 90])).toBe(true);
    expect(settled([100, 101, 140], [102, 103, 90])).toBe(false);
    expect(settledAll([100, 101, 102], [104, 105, 106])).toBe(false);
    expect(settledAll([100, 101, 102], [98, 99, 100])).toBe(true);
    expect(settledAll([], [80])).toBe(false);
    expect(settledAll([80], [])).toBe(false);
  });
});

/**
 * Runs of `inputIdle`, in µs, 25 a build, made as `bench:compare --suite
 * app` makes them on a shared 4-core VM on 2026-11-26, at a load of 1.1 to
 * 1.9. `planted` is main against main with a loop in the input stage that
 * made the variant 9.5% slower over 448 rounds; `alike` is main against a
 * second checkout of main.
 */
const recorded = {
  planted: {
    base: [
      2.884, 2.776, 5.265, 2.787, 2.835, 2.936, 2.681, 2.772, 2.766, 2.862,
      2.601, 2.68, 2.819, 2.664, 2.613, 3.221, 2.975, 2.829, 2.72, 2.674, 2.642,
      2.642, 2.773, 2.621, 4.909,
    ],
    head: [
      3.104, 3.157, 2.985, 2.835, 2.983, 3.239, 3.006, 3.133, 3.285, 3.295,
      3.166, 3.062, 3.02, 2.869, 3.102, 3.076, 3.206, 2.879, 3.16, 2.952, 2.872,
      3.007, 3, 3.058, 3.028,
    ],
  },
  alike: {
    base: [
      2.735, 2.619, 2.764, 2.803, 2.757, 2.553, 2.69, 2.562, 3.007, 2.701,
      2.804, 2.986, 2.845, 2.73, 2.785, 2.891, 2.978, 3.402, 2.996, 2.673,
      2.874, 2.746, 2.755, 2.816, 2.804,
    ],
    head: [
      2.546, 2.668, 2.647, 2.637, 2.685, 2.664, 2.727, 4.117, 2.844, 3.065,
      2.718, 2.915, 3.215, 2.653, 2.766, 2.822, 3.023, 2.806, 2.991, 2.941,
      3.052, 2.933, 2.943, 2.953, 2.706,
    ],
  },
};

describe("the verdict on an app's stage, on runs recorded", () => {
  it("is slower by every run where the fastest runs of the first six let a slowdown of a tenth go", () => {
    const { base, head } = recorded.planted;
    expect(settled(base.slice(0, ENOUGH), head.slice(0, ENOUGH))).toBe(true);
    for (let runs = ENOUGH; runs <= base.length; runs++) {
      expect(
        settledAll(base.slice(0, runs), head.slice(0, runs)),
        `after ${runs} runs`
      ).toBe(false);
    }
    expect(judgeAll(base, head).outcome).toBe("slower");
  });

  it("is the same by either rule for two checkouts of one source", () => {
    const { base, head } = recorded.alike;
    expect(judge(base, head).outcome).toBe("the same");
    expect(judgeAll(base, head).outcome).toBe("the same");
  });
});

describe("what a change slows on purpose", () => {
  it("is what its commits name on a line of their messages, over as many lines as it takes", () => {
    const log = [
      "Accessors without code generation",
      "",
      "What `each` hands out is closures.",
      "",
      "Bench-slower: each, eachMany, fragmented,",
      "  withMask,   withSorted",
      "\twatchedEach",
      "",
      "Co-Authored-By: Someone <someone@example.com>",
      "",
      "A fix",
      "",
      "bench-slower: hash",
      "Not-a-trailer: raw",
    ].join("\n");
    expect(Array.from(onPurpose(log)).toSorted()).toEqual([
      "each",
      "eachMany",
      "fragmented",
      "hash",
      "watchedEach",
      "withMask",
      "withSorted",
    ]);
  });

  it("is nothing where no commit says so, or says it of nothing", () => {
    expect(onPurpose("").size).toBe(0);
    expect(onPurpose("The bench is slower: each").size).toBe(0);
    expect(onPurpose("Bench-slower:\n\nRefs: #1").size).toBe(0);
  });
});

describe("the report", () => {
  const line = (name: string, verdict: Line["verdict"]): Line => ({
    name,
    label: `label of ${name}`,
    unit: "ns/entity",
    verdict,
  });
  const base = Array.from({ length: 15 }, (_, i) => 10 + i / 100);
  const lines = [
    line("same", judge(base, base)),
    line(
      "quick",
      judge(
        base,
        base.map((run) => run * 0.5)
      )
    ),
    line("fresh", judge([], [4, 5])),
    line(
      "meant",
      judge(
        base,
        base.map((run) => run * 1.5),
        true
      )
    ),
    line(
      "slow",
      judge(
        base,
        base.map((run) => run * 1.25)
      )
    ),
  ];

  it("fails on what is slower and was not meant to be, and on nothing else", () => {
    expect(failures(lines)).toEqual(["slow"]);
    expect(failures(lines.slice(0, 4))).toEqual([]);
  });

  it("is a table with what failed first, then what changed, and each build's fastest run", () => {
    expect(table(lines).split("\n")).toEqual([
      "| Variant | Base | Head | Change | Runs that beat every run of the other, and how often by chance | |",
      "| --- | ---: | ---: | ---: | --- | --- |",
      "| label of slow (`slow`) | 10.00 | 12.50 ns/entity | +25.0% | 15 of 15, 1 in 155,117,520 | **slower** |",
      "| label of meant (`meant`) | 10.00 | 15.00 ns/entity | +50.0% | 15 of 15, 1 in 155,117,520 | slower on purpose |",
      "| label of quick (`quick`) | 10.00 | 5.00 ns/entity | −50.0% | 15 of 15, 1 in 155,117,520 | faster |",
      "| label of fresh (`fresh`) | | 4.00 ns/entity | | | new |",
      "| label of same (`same`) | 10.00 | 10.00 ns/entity | +0.0% | 0 of 15, often | the same |",
    ]);
  });

  it("heads the column of what was counted as it is told, and adds the bytes a frame of each build allocates", () => {
    const drawn = (
      name: string,
      verdict: Line["verdict"],
      bytes: NonNullable<Line["bytes"]>
    ): Line => ({ ...line(name, verdict), bytes });
    const slow = base.map((run) => run * 1.25);
    expect(
      table(
        [
          drawn("same", judgeAll(base, base), { base: 5000, head: 5000 }),
          drawn("fresh", judgeAll([], [4, 5]), {
            base: Number.NaN,
            head: 7040.5,
          }),
          drawn("slow", judgeAll(base, slow), { base: 5016, head: 10_296 }),
        ],
        "Pairs of runs, one of each, that the faster won"
      ).split("\n")
    ).toEqual([
      "| Variant | Base | Head | Change | Pairs of runs, one of each, that the faster won, and how often by chance | Bytes a frame | |",
      "| --- | ---: | ---: | ---: | --- | ---: | --- |",
      "| label of slow (`slow`) | 10.07 | 12.59 ns/entity | +25.0% | 225 of 225, 1 in 155,117,520 | 5,016 → 10,296 | **slower** |",
      "| label of fresh (`fresh`) | | 4.50 ns/entity | | | 7,041 | new |",
      "| label of same (`same`) | 10.07 | 10.07 ns/entity | +0.0% | 112.5 of 225, often | 5,000 → 5,000 | the same |",
    ]);
  });
});
