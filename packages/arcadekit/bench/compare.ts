/**
 * Did a change make the storage core, or what an app's stages cost, slower?
 * Runs the variants of a suite for two checkouts of the repository, the base
 * and this one, turn and turn about, and says for each whether this one is
 * slower by more than the noise. It ends with a failure if any is, unless a
 * commit of the change says it meant to.
 *
 *   pnpm --filter arcadekit bench:compare <base checkout> [options]
 *
 *   --suite <name>    `core`, the variants of `bench/core.ts`, when left
 *                     out, or `app`, those of `bench/app.ts`
 *   --runs <n>        runs of each variant by each build: when left out,
 *                     15 of the storage core's and 25 of an app's stages'
 *   --only <a,b,...>  these variants alone
 *   --since <commit>  where the change begins, to read its commits'
 *                     messages from: the base checkout's HEAD when left out
 *
 * The base is a second checkout of the repository with its dependencies
 * installed, at the commit to compare with:
 *
 *   git worktree add ../base origin/next
 *   (cd ../base && pnpm install --frozen-lockfile)
 *   pnpm --filter arcadekit bench:compare "$PWD/../base"
 *
 * The `Benchmarks` workflow, `.github/workflows/bench.yml`, runs both suites
 * on a pull request that touches the package's source, against what the
 * pull request would be merged into.
 *
 * Both builds run this checkout's `bench/core.ts`, and with `--suite app`
 * its `bench/app.ts`, as `bench/checkouts.ts` says, which also says what a
 * variant the base cannot run comes to, and how a commit says it slows one
 * on purpose. `bench/verdict.ts` holds the rules, `judge` for the storage
 * core and `judgeAll` for an app's stages, and says why each is the rule,
 * what it finds and what it does not.
 *
 * A variant whose two builds are within 2.5% of each other after six runs
 * each is not run again, which is most variants of most changes: the whole
 * check took five minutes for two builds that were the same, and eight for
 * two of which eight variants differed. The workflow's first run, on the
 * pull request that added it, took seven and a half minutes on GitHub's own
 * machine: the variants that pull request's commits name as slowed on
 * purpose were found slower in fifteen runs of fifteen, a program of ten
 * components 36% faster, and the rest the same.
 *
 * An app's stages take a few microseconds, and each build runs them 25
 * times, judged by every run: a variant is let go after six runs each when
 * its medians are within 2.5%. On a shared 4-core VM, a loop planted in the
 * input stage that made it 9.5% slower was found in 10 comparisons of 10,
 * where judging by the fastest runs found it in 9 and let the tenth go
 * after six runs; with 15 runs, in 21 of 22 where the fastest runs found it
 * in 18. Against a second checkout of the same source, it called every
 * variant the same in 20 comparisons of 20, each in 4.5 to 5.6 minutes,
 * where judging by the fastest runs took 6.2 to 8.7.
 */
import { variants as appVariants } from "./app.ts";
import { ENOUGH, compare, report } from "./checkouts.ts";
import type { Suite } from "./checkouts.ts";
import { variants as coreVariants, inUnit } from "./core.ts";
import type { Variant } from "./core.ts";
import {
  CHANCE,
  FLOOR,
  failures,
  judge,
  judgeAll,
  settled,
  settledAll,
  table,
} from "./verdict.ts";
import type { Line, Verdict } from "./verdict.ts";

/**
 * What each suite compares, by which rule, and how the report begins and
 * ends. A run prints the median milliseconds of a pass.
 */
interface ArcadekitSuite extends Suite<number> {
  readonly variants: Record<string, Variant>;
  readonly what: string;
  readonly judge: (
    base: readonly number[],
    head: readonly number[],
    onPurpose: boolean
  ) => Verdict;
  readonly plainly?: string;
  readonly rule: string;
}

const { compared, suite } = compare<number, ArcadekitSuite>({
  command: "pnpm --filter arcadekit bench:compare",
  folder: "packages/arcadekit",
  node: ["--import", "tsx"],
  suites: {
    core: {
      file: "core.ts",
      variants: coreVariants,
      runs: 15,
      read: Number,
      settled,
      what: "The storage core is",
      judge,
      rule: `Each build's time is that of its fastest run. A variant is slower when its fastest run is more than ${FLOOR * 100}% slower than the base's and so many of the base's runs beat every one of its own that two builds alike would look so once in ${1 / CHANCE} comparisons or less; one whose builds are within ${(FLOOR / 2) * 100}% after ${ENOUGH} runs each is not run again.`,
    },
    app: {
      file: "app.ts",
      imports: ["core.ts"],
      variants: appVariants,
      runs: 25,
      read: Number,
      settled: settledAll,
      what: "An app's stages are",
      judge: judgeAll,
      plainly: "Pairs of runs, one of each, that the faster won",
      rule: `Each build's time is the median of its runs. A variant is slower when its median run is more than ${FLOOR * 100}% slower than the base's and the base's runs beat its own in so many of the pairs of one run of each that two builds alike would look so once in ${1 / CHANCE} comparisons or less; one whose medians are within ${(FLOOR / 2) * 100}% after ${ENOUGH} runs each is not run again.`,
    },
  },
});

const lines: Line[] = compared.map(({ base, head, label, meant, name }) => {
  const variant = suite.variants[name]!;
  return {
    name,
    label,
    unit: inUnit(variant, 0).unit,
    verdict: suite.judge(
      base.map((ms) => inUnit(variant, ms).value),
      head.map((ms) => inUnit(variant, ms).value),
      meant
    ),
  };
});
const failed = failures(lines);
report(
  [
    failed.length === 0
      ? `### ${suite.what} no slower`
      : `### ${suite.what} slower: ${failed.join(", ")}`,
    "",
    table(lines, suite.plainly),
    "",
    suite.rule,
    ...(failed.length === 0
      ? []
      : [
          "",
          `If the change is meant to slow ${failed.length === 1 ? "it" : "them"}, a commit of it says so, with a line in its message: \`Bench-slower: ${failed.join(", ")}\`.`,
        ]),
  ].join("\n"),
  failed
);
