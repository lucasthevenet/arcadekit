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
 * on purpose. `bench/verdict.ts` holds the rule, `judge`, and says why it is
 * the rule, what it finds and what it does not.
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
 * An app's stages take a few microseconds, and a build's fastest run of one
 * is up to a fifth apart from one process to the next, so each build runs
 * them 25 times. On a shared 4-core VM, 15 runs found the input stage 40%
 * slower in no stretch of 15 rounds out of 25, and 21 runs in four stretches
 * of five. Compared with the same source, the suite took ten minutes at 15
 * runs, eight of its fifteen variants let go after six, and found none
 * slower.
 */
import { variants as appVariants } from "./app.ts";
import { ENOUGH, compare, report } from "./checkouts.ts";
import type { Suite } from "./checkouts.ts";
import { variants as coreVariants, inUnit } from "./core.ts";
import type { Variant } from "./core.ts";
import { CHANCE, FLOOR, failures, judge, settled, table } from "./verdict.ts";
import type { Line } from "./verdict.ts";

/**
 * What each suite compares, and how the report begins. A run prints the
 * median milliseconds of a pass.
 */
interface ArcadekitSuite extends Suite<number> {
  readonly variants: Record<string, Variant>;
  readonly what: string;
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
    },
    app: {
      file: "app.ts",
      imports: ["core.ts"],
      variants: appVariants,
      runs: 25,
      read: Number,
      settled,
      what: "An app's stages are",
    },
  },
});

const lines: Line[] = compared.map(({ base, head, label, meant, name }) => {
  const variant = suite.variants[name]!;
  return {
    name,
    label,
    unit: inUnit(variant, 0).unit,
    verdict: judge(
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
    table(lines),
    "",
    `Each build's time is that of its fastest run. A variant is slower when its fastest run is more than ${FLOOR * 100}% slower than the base's and so many of the base's runs beat every one of its own that two builds alike would look so once in ${1 / CHANCE} comparisons or less; one whose builds are within ${(FLOOR / 2) * 100}% after ${ENOUGH} runs each is not run again.`,
    ...(failed.length === 0
      ? []
      : [
          "",
          `If the change is meant to slow ${failed.length === 1 ? "it" : "them"}, a commit of it says so, with a line in its message: \`Bench-slower: ${failed.join(", ")}\`.`,
        ]),
  ].join("\n"),
  failed
);
