/**
 * What a comparison of two builds comes to: the arithmetic of
 * `bench/compare.ts`, apart from it so that a test can hold it to account.
 * Plain functions of numbers and text, with nothing of Node in them.
 *
 * A variant of the benchmark is run several times by each build, turn and
 * turn about, and each run gives one number: the median time of a pass. On
 * a shared machine a run is now and then much slower than the rest, one in
 * six of them half as slow again where this was written, and never much
 * faster. So a build is known by its fastest run.
 *
 * The head is slower than the base when both of these hold:
 *
 * - Enough of the base's runs were faster than the head's fastest for that
 *   to be no accident. If the two builds were the same, every way of
 *   dealing the runs between them would be as likely as any other, and the
 *   share of those in which so many of the one's runs beat all of the
 *   other's is a number that can be worked out: `chance`. It has to be
 *   under `CHANCE`, one in a thousand. With fifteen runs each that is nine
 *   of the base's fifteen, so six of them may have been disturbed.
 * - The head's fastest run is slower than the base's fastest by more than
 *   `FLOOR`, a twentieth: about what moving code about does to a loop that
 *   was not touched.
 *
 * The first is the noise, counted as the comparison goes, with nothing
 * assumed about its shape: on a machine where the runs are far apart, fewer
 * of them are told apart, and a difference has to be plainer to count.
 *
 * What it finds, on a machine as noisy as that one: a slowdown of 15%, nine
 * times in ten. The first time it was run it found one that the full
 * benchmark had shown and that had been put down to the machine: a change
 * query's visit of one entity, a fifth slower.
 *
 * What it does not: a slowdown of less than `FLOOR`, or several such one
 * after the other; and anything outside the storage core, a tick or an
 * action's dispatch, which `pnpm --filter arcadekit bench` reports and
 * nothing compares.
 */

/** How much slower the fastest run has to be, beyond the noise: a twentieth. */
export const FLOOR = 0.05;

/** How rarely two builds that are the same may be found to differ one way. */
export const CHANCE = 0.001;

export type Outcome =
  /** Slower by more than the noise, and no commit says it was meant. */
  | "slower"
  /** Slower by more than the noise, as a commit of the change says it is. */
  | "slower on purpose"
  | "faster"
  | "the same"
  /** The base could not run it: there is nothing to compare with. */
  | "new";

/** What a comparison says, from whether its difference is plain and how large it is. */
const outcomeOf = (
  plain: boolean,
  ratio: number,
  onPurpose: boolean
): Outcome => {
  if (plain && ratio > 1 + FLOOR) {
    return onPurpose ? "slower on purpose" : "slower";
  }

  return plain && ratio < 1 / (1 + FLOOR) ? "faster" : "the same";
};

export interface Verdict {
  readonly outcome: Outcome;
  /** The head's fastest run over the base's: 1.1 is a tenth slower. */
  readonly ratio: number;
  /** The base's fastest run, and the head's, in the unit they were given in. */
  readonly base: number;
  readonly head: number;
  /**
   * How many runs of the build that looks faster beat every run of the
   * other, and out of how many.
   */
  readonly beaten: number;
  readonly of: number;
  /**
   * How often two builds that are the same would look this far apart, this
   * way round: 0.001 is once in a thousand comparisons.
   */
  readonly chance: number;
}

/**
 * How often, when `winners + losers` runs are dealt at random into a hand
 * of `winners` and a hand of `losers`, the fastest `beaten` of them all
 * land in the first hand: which is what it takes for that many runs of
 * one build to beat every run of the other.
 *
 * `(w / n) * ((w - 1) / (n - 1)) * ...`, `beaten` times over: the fastest
 * run is in the first hand, then the next of what is left, and so on.
 */
export const chance = (
  beaten: number,
  winners: number,
  losers: number
): number => {
  let share = 1;

  for (let i = 0; i < beaten; i += 1) {
    share *= (winners - i) / (winners + losers - i);
  }

  return share;
};

/** How many of `runs` are faster than `than`. */
const faster = (runs: readonly number[], than: number): number => {
  let count = 0;

  for (const run of runs) {
    if (run < than) {
      count += 1;
    }
  }

  return count;
};

/**
 * Compares the runs of one variant by two builds. `onPurpose` says that a
 * commit of the change names the variant as one it slows.
 */
export const judge = (
  base: readonly number[],
  head: readonly number[],
  onPurpose = false
): Verdict => {
  if (head.length === 0) {
    throw new Error("judge() was given no run of the head to judge.");
  }

  const best = Math.min(...head);

  if (base.length === 0) {
    return {
      outcome: "new",
      ratio: 1,
      base: Number.NaN,
      head: best,
      beaten: 0,
      of: 0,
      chance: 1,
    };
  }

  const was = Math.min(...base);
  const ratio = best / was;
  // Which way round it looks, and how plainly.
  const slower = ratio >= 1;
  const beaten = slower ? faster(base, best) : faster(head, was);
  const of = slower ? base.length : head.length;
  const share = chance(beaten, of, slower ? head.length : base.length);
  const plain = share <= CHANCE;

  return {
    outcome: outcomeOf(plain, ratio, onPurpose),
    ratio,
    base: was,
    head: best,
    beaten,
    of,
    chance: share,
  };
};

/**
 * Whether a variant need not be run again: its fastest runs are within
 * half the floor of each other, so that more runs would not find the two
 * builds apart. It only ever spares runs: a variant that is let go is the
 * same, and one that is not is judged when every run is in.
 */
export const settled = (
  base: readonly number[],
  head: readonly number[]
): boolean => {
  if (base.length === 0 || head.length === 0) {
    return false;
  }

  const ratio = Math.min(...head) / Math.min(...base);

  return ratio < 1 + FLOOR / 2 && ratio > 1 / (1 + FLOOR / 2);
};

/**
 * The variants that the commits of a change say they slow on purpose. A
 * commit says so with a line of its message that reads
 *
 *   Bench-slower: each, eachMany
 *
 * and may go on over the lines that follow, indented. `log` is the
 * messages of the change's commits, one after the other.
 */
export const onPurpose = (log: string): Set<string> => {
  const named = new Set<string>();
  const lines = log.split("\n");

  for (let at = 0; at < lines.length; at += 1) {
    const match = /^\s*Bench-slower:(?<names>.*)$/iu.exec(lines[at]!);

    if (match === null) {
      continue;
    }

    let names = match.groups!.names!;

    // As a trailer is continued: by lines that begin with a space.
    while (at + 1 < lines.length && /^\s+\S/u.test(lines[at + 1]!)) {
      at += 1;
      names += ` ${lines[at]!}`;
    }

    for (const name of names.split(/[\s,]+/u)) {
      if (name !== "") {
        named.add(name);
      }
    }
  }

  return named;
};

export interface Line {
  readonly name: string;
  readonly label: string;
  /** The unit `verdict.base` and `verdict.head` are in. */
  readonly unit: string;
  readonly verdict: Verdict;
}

const percent = (ratio: number): string =>
  `${ratio >= 1 ? "+" : "−"}${(Math.abs(ratio - 1) * 100).toFixed(1)}%`;

const rarity = (share: number): string =>
  share >= 0.1
    ? "often"
    : `1 in ${Math.round(1 / share).toLocaleString("en-US")}`;

/** The comparison as a table in Markdown: what failed first, then what changed. */
export const table = (lines: readonly Line[]): string => {
  const rank = (line: Line): number =>
    ["slower", "slower on purpose", "faster", "new", "the same"].indexOf(
      line.verdict.outcome
    );

  const rows = lines
    .map((line, at) => ({ line, at }))
    .toSorted((a, b) => rank(a.line) - rank(b.line) || a.at - b.at)
    .map(({ line: { label, name, unit, verdict } }) =>
      verdict.outcome === "new"
        ? `| ${label} (\`${name}\`) | | ${verdict.head.toFixed(2)} ${unit} | | | new |`
        : `| ${label} (\`${name}\`) | ${verdict.base.toFixed(2)} | ${verdict.head.toFixed(2)} ${unit} | ${percent(verdict.ratio)} | ${verdict.beaten} of ${verdict.of}, ${rarity(verdict.chance)} | ${verdict.outcome === "slower" ? "**slower**" : verdict.outcome} |`
    );

  return [
    "| Variant | Base | Head | Change | Runs that beat every run of the other, and how often by chance | |",
    "| --- | ---: | ---: | ---: | --- | --- |",
    ...rows,
  ].join("\n");
};

/** The names of the variants that fail the check. */
export const failures = (lines: readonly Line[]): string[] =>
  lines.flatMap((line) =>
    line.verdict.outcome === "slower" ? [line.name] : []
  );
