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
 * after the other; and what the two suites, the storage core's and an app's
 * stages', leave out, such as an action's dispatch or a tick over 100,000
 * entities, which `pnpm --filter arcadekit bench` reports and nothing
 * compares. An app's stages take a few microseconds, and a build's fastest
 * run of one is up to a fifth apart from one process to the next, so a
 * slowdown of one is found when it is about a third, in 25 runs a build.
 * Nor does it find a slowdown of most runs that leaves the fastest where it
 * was: issue #450 measured two builds of the loops that draw whose fastest
 * runs were within a tenth, and whose medians were up to 43% apart.
 *
 * `judgeAll` reads every run, and `@arcadekit/three`'s `bench/compare.ts`
 * judges the loops that draw by it. The head is slower when both of these
 * hold:
 *
 * - The base's runs beat the head's in so many of the pairs of one run of
 *   each that two builds alike would look so once in `1 / CHANCE`
 *   comparisons or less: `pairChance`, the rank-sum test of Mann and
 *   Whitney, worked out exactly.
 * - The head's median run is slower than the base's by more than `FLOOR`.
 *
 * As with `judge`, the first assumes nothing of the noise's shape, and a
 * disturbed run counts as one pair lost, however slow it was.
 */

/**
 * How much slower the fastest run, or with `judgeAll` the median one, has to
 * be, beyond the noise: a twentieth.
 */
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

export interface Verdict {
  readonly outcome: Outcome;
  /**
   * The head's fastest run over the base's, or with `judgeAll` its median
   * run over the base's: 1.1 is a tenth slower.
   */
  readonly ratio: number;
  /** The two runs of `ratio`, the base's and the head's, in their unit. */
  readonly base: number;
  readonly head: number;
  /**
   * How many runs of the build that looks faster beat every run of the
   * other, and out of how many. With `judgeAll`, in how many of the pairs
   * of one run of each the run of the build that looks faster was faster,
   * and out of how many pairs.
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
  for (let i = 0; i < beaten; i++) {
    share *= (winners - i) / (winners + losers - i);
  }
  return share;
};

/** How many of `runs` are faster than `than`. */
const faster = (runs: readonly number[], than: number): number => {
  let count = 0;
  for (const run of runs) {
    if (run < than) {
      count++;
    }
  }
  return count;
};

/** What a difference this plain and this large comes to. */
const outcomeOf = (share: number, ratio: number, onPurpose: boolean): Outcome =>
  share <= CHANCE && ratio > 1 + FLOOR
    ? onPurpose
      ? "slower on purpose"
      : "slower"
    : share <= CHANCE && ratio < 1 / (1 + FLOOR)
      ? "faster"
      : "the same";

/** The verdict on a variant the base could not run. */
const fresh = (head: number): Verdict => ({
  outcome: "new",
  ratio: 1,
  base: Number.NaN,
  head,
  beaten: 0,
  of: 0,
  chance: 1,
});

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
    return fresh(best);
  }
  const was = Math.min(...base);
  const ratio = best / was;
  // Which way round it looks, and how plainly.
  const slower = ratio >= 1;
  const beaten = slower ? faster(base, best) : faster(head, was);
  const of = slower ? base.length : head.length;
  const share = chance(beaten, of, slower ? head.length : base.length);
  return {
    outcome: outcomeOf(share, ratio, onPurpose),
    ratio,
    base: was,
    head: best,
    beaten,
    of,
    chance: share,
  };
};

/** What `deals` has worked out, by the sizes of the hands. */
const worked = new Map<string, Float64Array>();

/**
 * For hands of `winners` and `losers` runs, the share of the deals in which
 * the first hand won each number of pairs, from none to all.
 *
 * The slowest run of all is in the second hand `losers / (winners +
 * losers)` of the time, and then every run of the first beats it, which is
 * `winners` pairs; or it is in the first, and beats none. Either way the
 * rest are dealt as before, with one run fewer.
 */
const deals = (winners: number, losers: number): Float64Array => {
  const key = `${winners} ${losers}`;
  const known = worked.get(key);
  if (known !== undefined) {
    return known;
  }
  let shares = Array.from({ length: losers + 1 }, () => Float64Array.of(1));
  for (let i = 1; i <= winners; i++) {
    const next = [Float64Array.of(1)];
    for (let j = 1; j <= losers; j++) {
      const shared = new Float64Array(i * j + 1);
      const slowestInFirst = shares[j]!;
      const slowestInSecond = next[j - 1]!;
      for (let u = 0; u < slowestInFirst.length; u++) {
        shared[u]! += (i / (i + j)) * slowestInFirst[u]!;
      }
      for (let u = 0; u < slowestInSecond.length; u++) {
        shared[u + i]! += (j / (i + j)) * slowestInSecond[u]!;
      }
      next.push(shared);
    }
    shares = next;
  }
  worked.set(key, shares[losers]!);
  return shares[losers]!;
};

/**
 * How often, when `winners + losers` runs are dealt at random into a hand
 * of `winners` and a hand of `losers`, the first hand's run is the faster
 * in `pairs` or more of the pairs of one run from each hand: which is what
 * it takes for one build's runs to beat the other's so often. A tie counts
 * half a pair, and `pairs` is rounded down, so that a tie never makes the
 * chance smaller than it is.
 */
export const pairChance = (
  pairs: number,
  winners: number,
  losers: number
): number => {
  const dealt = deals(winners, losers);
  let share = 0;
  for (let u = Math.max(0, Math.floor(pairs)); u < dealt.length; u++) {
    share += dealt[u]!;
  }
  return Math.min(share, 1);
};

/** The middle run, or the mean of the two in the middle. */
export const median = (runs: readonly number[]): number => {
  const sorted = runs.toSorted((a, b) => a - b);
  const half = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[half]!
    : (sorted[half - 1]! + sorted[half]!) / 2;
};

/** In how many pairs of a run of `runs` and one of `others` the first is faster. */
const pairsWon = (
  runs: readonly number[],
  others: readonly number[]
): number => {
  let won = 0;
  for (const run of runs) {
    for (const other of others) {
      won += run < other ? 1 : run === other ? 0.5 : 0;
    }
  }
  return won;
};

/**
 * Compares the runs of one variant by two builds by every run, where
 * `judge` reads the fastest of each: by their medians, and by the pairs of
 * one run of each that each build won. `onPurpose` says that a commit of
 * the change names the variant as one it slows.
 */
export const judgeAll = (
  base: readonly number[],
  head: readonly number[],
  onPurpose = false
): Verdict => {
  if (head.length === 0) {
    throw new Error("judgeAll() was given no run of the head to judge.");
  }
  const now = median(head);
  if (base.length === 0) {
    return fresh(now);
  }
  const was = median(base);
  const ratio = now / was;
  const slower = ratio >= 1;
  const beaten = slower ? pairsWon(base, head) : pairsWon(head, base);
  const share = slower
    ? pairChance(beaten, base.length, head.length)
    : pairChance(beaten, head.length, base.length);
  return {
    outcome: outcomeOf(share, ratio, onPurpose),
    ratio,
    base: was,
    head: now,
    beaten,
    of: base.length * head.length,
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
  for (let at = 0; at < lines.length; at++) {
    const match = /^\s*Bench-slower:(.*)$/iu.exec(lines[at]!);
    if (match === null) {
      continue;
    }
    let names = match[1]!;
    // As a trailer is continued: by lines that begin with a space.
    while (at + 1 < lines.length && /^\s+\S/u.test(lines[at + 1]!)) {
      names += ` ${lines[++at]!}`;
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
  /**
   * What a frame of each build allocates, the median of its runs, for a
   * variant that measures it.
   */
  readonly bytes?: { readonly base: number; readonly head: number };
}

const percent = (ratio: number): string =>
  `${ratio >= 1 ? "+" : "−"}${(Math.abs(ratio - 1) * 100).toFixed(1)}%`;

const rarity = (share: number): string =>
  share >= 0.1
    ? "often"
    : `1 in ${Math.round(1 / share).toLocaleString("en-US")}`;

const count = (value: number): string =>
  Math.round(value).toLocaleString("en-US");

/**
 * The comparison as a table in Markdown: what failed first, then what
 * changed. `plainly` heads the column of what `Verdict.beaten` counted, and
 * a column of the bytes a frame allocates follows when a line has them.
 */
export const table = (
  lines: readonly Line[],
  plainly = "Runs that beat every run of the other"
): string => {
  const rank = (line: Line): number =>
    ["slower", "slower on purpose", "faster", "new", "the same"].indexOf(
      line.verdict.outcome
    );
  const withBytes = lines.some((line) => line.bytes !== undefined);
  const bytesOf = ({ bytes, verdict }: Line): string =>
    !withBytes
      ? ""
      : bytes === undefined
        ? " |"
        : verdict.outcome === "new"
          ? ` ${count(bytes.head)} |`
          : ` ${count(bytes.base)} → ${count(bytes.head)} |`;
  const rows = lines
    .map((line, at) => ({ line, at }))
    .toSorted((a, b) => rank(a.line) - rank(b.line) || a.at - b.at)
    .map(({ line }) => {
      const { label, name, unit, verdict } = line;
      return verdict.outcome === "new"
        ? `| ${label} (\`${name}\`) | | ${verdict.head.toFixed(2)} ${unit} | | |${bytesOf(line)} new |`
        : `| ${label} (\`${name}\`) | ${verdict.base.toFixed(2)} | ${verdict.head.toFixed(2)} ${unit} | ${percent(verdict.ratio)} | ${verdict.beaten} of ${verdict.of}, ${rarity(verdict.chance)} |${bytesOf(line)} ${verdict.outcome === "slower" ? "**slower**" : verdict.outcome} |`;
    });
  return [
    `| Variant | Base | Head | Change | ${plainly}, and how often by chance |${withBytes ? " Bytes a frame |" : ""} |`,
    `| --- | ---: | ---: | ---: | --- |${withBytes ? " ---: |" : ""} --- |`,
    ...rows,
  ].join("\n");
};

/** The names of the variants that fail the check. */
export const failures = (lines: readonly Line[]): string[] =>
  lines
    .filter((line) => line.verdict.outcome === "slower")
    .map((line) => line.name);
