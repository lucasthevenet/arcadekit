/**
 * Did a change make the loops that draw slower? Runs the variants of
 * `bench/instances.ts` for two checkouts of the repository, the base and
 * this one, turn and turn about, and says for each whether this one is
 * slower by more than the noise, with the bytes a frame of each allocates
 * beside it. It ends with a failure if any is, unless a commit of the
 * change says it meant to.
 *
 *   pnpm --filter @arcadekit/three bench:compare <base checkout> [options]
 *
 *   --runs <n>        runs of each variant by each build: 30 when left out
 *   --only <a,b,...>  these variants alone
 *   --since <commit>  where the change begins, to read its commits'
 *                     messages from: the base checkout's HEAD when left out
 *
 * The base is a second checkout of the repository with its dependencies
 * installed, at the commit to compare with:
 *
 *   git worktree add ../base origin/main
 *   (cd ../base && pnpm install --frozen-lockfile)
 *   pnpm --filter @arcadekit/three bench:compare "$PWD/../base"
 *
 * It runs as `arcadekit`'s comparison does, by its `bench/checkouts.ts`,
 * and judges by `judgeAll` of its `bench/verdict.ts`, which reads every
 * run where the storage core's rule reads the fastest: a variant is slower
 * when its median run is slower than the base's by more than a twentieth,
 * and the base's runs beat its own in so many of the pairs of one run of
 * each that two builds alike would look so once in a thousand comparisons
 * or less. Issue #450 measured two builds of these loops whose fastest runs
 * were within a tenth and whose medians were up to 43% apart.
 *
 * A run of a drawing loop is now and then much slower than the rest, as a
 * run of the storage core is, and such a run wins no pair: so this rule
 * needs more runs than the storage core's to find as much, 30 a build to
 * find a slowdown of a fourteenth nine times in ten where the storage
 * core's rule needs 15. Every variant makes every run, since a variant let
 * go early would be one the rule did not read whole. A run takes about a
 * second and a half, so the whole suite takes about half an hour, and the
 * four smooth variants, `--only smooth,smoothAll,smoothFlat,smoothFlatAll`,
 * six minutes.
 */
import { compare, report } from "../../arcadekit/bench/checkouts.ts";
import type { Suite } from "../../arcadekit/bench/checkouts.ts";
import {
  CHANCE,
  FLOOR,
  failures,
  judgeAll,
  median,
  table,
} from "../../arcadekit/bench/verdict.ts";
import type { Line } from "../../arcadekit/bench/verdict.ts";
import { variants } from "./instances.ts";
import type { Measured } from "./instances.ts";

/** A run, from what `bench/instances.ts <name>` printed. */
const read = (printed: unknown): Measured => {
  if (
    typeof printed === "object" &&
    printed !== null &&
    "ns" in printed &&
    "bytes" in printed &&
    typeof printed.ns === "number" &&
    typeof printed.bytes === "number"
  ) {
    return { ns: printed.ns, bytes: printed.bytes };
  }
  throw new Error(
    `bench/instances.ts printed ${JSON.stringify(printed)}, where a run prints {"ns":…,"bytes":…}.`
  );
};

const { compared } = compare<Measured, Suite<Measured>>({
  command: "pnpm --filter @arcadekit/three bench:compare",
  folder: "packages/three",
  node: ["--import", "tsx", "--conditions=source"],
  suites: {
    draw: {
      file: "instances.ts",
      variants,
      runs: 30,
      read,
    },
  },
});

const lines: Line[] = compared.map(({ base, head, label, meant, name }) => ({
  name,
  label,
  unit: "ns/entity",
  verdict: judgeAll(
    base.map(({ ns }) => ns),
    head.map(({ ns }) => ns),
    meant
  ),
  bytes: {
    base:
      base.length === 0 ? Number.NaN : median(base.map(({ bytes }) => bytes)),
    head: median(head.map(({ bytes }) => bytes)),
  },
}));
const failed = failures(lines);
report(
  [
    failed.length === 0
      ? "### The loops that draw are no slower"
      : `### The loops that draw are slower: ${failed.join(", ")}`,
    "",
    table(lines, "Pairs of runs, one of each, that the faster won"),
    "",
    `Each build's time, and what a frame allocates, is the median of its runs. A variant is slower when its median run is more than ${FLOOR * 100}% slower than the base's and the base's runs beat its own in so many of the pairs of one run of each that two builds alike would look so once in ${1 / CHANCE} comparisons or less.`,
    ...(failed.length === 0
      ? []
      : [
          "",
          `If the change is meant to slow ${failed.length === 1 ? "it" : "them"}, a commit of it says so, with a line in its message: \`Bench-slower: ${failed.join(", ")}\`.`,
        ]),
  ].join("\n"),
  failed
);
