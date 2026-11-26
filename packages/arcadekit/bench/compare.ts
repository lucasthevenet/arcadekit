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
 * The `Benchmarks` workflow, `.github/workflows/bench.yml`, runs the storage
 * core's suite on a pull request that touches the storage core, against what
 * the pull request would be merged into. No workflow runs the app suite: a
 * change to what an app's stages do runs it by hand.
 *
 * Both builds run this checkout's `bench/core.ts`, and with `--suite app`
 * its `bench/app.ts`, which are copied into the base for as long as the
 * comparison lasts, under names of their own, so that the two are asked the
 * same thing and the base is left as it was found. A variant that uses what
 * the base's source does not have, as one does once a change to what a game
 * writes has rewritten it, is run in the base from the base's own file, and
 * the report says so: the two then do the same work as far as the change's
 * diff of the variant shows. A variant the base cannot run either way is
 * new, and compared with nothing. Each run is a process of its own.
 * `bench/verdict.ts` holds the rule, and says why it is the rule, what it
 * finds and what it does not.
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
 *
 * A commit that slows a variant on purpose says so in its message, and the
 * check then reports the variant and does not fail on it:
 *
 *   Bench-slower: each, eachMany
 *
 * It travels with the commit, so nothing is left to take out afterwards.
 * The list may go on over the lines that follow, indented.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { variants as appVariants } from "./app.ts";
import { variants as coreVariants, inUnit } from "./core.ts";
import type { Variant } from "./core.ts";
import {
  CHANCE,
  FLOOR,
  failures,
  judge,
  onPurpose,
  settled,
  table,
} from "./verdict.ts";
import type { Line } from "./verdict.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const head = path.resolve(here, "..");

const usage = (problem: string): never => {
  console.error(
    `${problem}\n\nUsage: pnpm --filter arcadekit bench:compare <base checkout> [--suite core|app] [--runs <n>] [--only <a,b,...>] [--since <commit>]`
  );
  process.exit(2);
};

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  if (at === -1) {
    return undefined;
  }
  const [, value] = args.splice(at, 2);
  return value ?? usage(`${name} is given a value.`);
};
/**
 * What each suite compares, in which file of `bench/`, how many runs of a
 * variant each build makes unless told, and how the report begins.
 */
const suites: Record<
  string,
  {
    readonly file: string;
    readonly variants: Record<string, Variant>;
    readonly runs: number;
    readonly what: string;
  }
> = {
  core: {
    file: "core.ts",
    variants: coreVariants,
    runs: 15,
    what: "The storage core is",
  },
  app: {
    file: "app.ts",
    variants: appVariants,
    runs: 25,
    what: "An app's stages are",
  },
};
const suiteName = option("--suite") ?? "core";
const suite =
  suites[suiteName] ??
  usage(
    `There is no suite "${suiteName}". The suites are: ${Object.keys(suites).join(", ")}.`
  );
const { variants } = suite;
const runs = Number(option("--runs") ?? suite.runs);
const only = option("--only")?.split(",");
const since = option("--since");
if (!Number.isInteger(runs) || runs < 1) {
  usage("--runs is given a whole number, 1 or more.");
}
if (args.length !== 1) {
  usage("bench:compare is given one checkout to compare with.");
}
// A path that is not absolute is from where the command was typed, which
// under pnpm is not where the script runs.
const baseRoot = path.resolve(process.env.INIT_CWD ?? process.cwd(), args[0]!);
const base = path.join(baseRoot, "packages", "arcadekit");
if (!existsSync(path.join(base, "src", "ecs", "world.ts"))) {
  usage(`${baseRoot} is not a checkout of this repository.`);
}
if (!existsSync(path.join(baseRoot, "node_modules"))) {
  usage(
    `${baseRoot} has no dependencies installed: run pnpm install --frozen-lockfile there first.`
  );
}

const names = Object.keys(variants).filter(
  (name) => only === undefined || only.includes(name)
);
for (const name of only ?? []) {
  if (variants[name] === undefined) {
    usage(
      `There is no variant "${name}". The variants are: ${Object.keys(variants).join(", ")}.`
    );
  }
}

// The base is asked what this checkout asks: its copy of the variants, kept
// there under names that are no files of the base's, and taken away again
// however the comparison ends. A checkout left with a file of its own
// changed would refuse to be moved to another commit. `bench/app.ts` takes
// what it measures with from `bench/core.ts`, and its copy from the copy.
const compared = (file: string): string =>
  file.replace(/\.ts$/u, ".compared.ts");
const copies = [...new Set(["core.ts", suite.file])].map((file) => ({
  at: path.join(base, "bench", compared(file)),
  text: readFileSync(path.join(head, "bench", file), "utf8").replaceAll(
    '"./core.ts"',
    `"./${compared("core.ts")}"`
  ),
}));
process.on("exit", () => {
  for (const { at } of copies) {
    rmSync(at, { force: true });
  }
});
for (const { at, text } of copies) {
  writeFileSync(at, text);
}

/**
 * The variants the base runs from its own file of the suite, since it cannot
 * run this checkout's: the change rewrote them for what a game now writes.
 */
const own = new Set<string>();

/** One run of a variant by a build: the median milliseconds of a pass. */
const run = (build: string, name: string): number =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        `bench/${build === base && !own.has(name) ? compared(suite.file) : suite.file}`,
        name,
      ],
      { cwd: build, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    )
      .trim()
      .split("\n")
      .pop()!
  ) as number;

/**
 * The base's first run of a variant: of this checkout's file, or else of the
 * base's own, or none when neither runs, and the variant is new.
 */
const first = (name: string): number | undefined => {
  try {
    return run(base, name);
  } catch {
    own.add(name);
    try {
      return run(base, name);
    } catch {
      own.delete(name);
      return undefined;
    }
  }
};

const git = (...command: string[]): string =>
  execFileSync("git", command, { cwd: head, encoding: "utf8" });
const meant = onPurpose(
  git(
    "log",
    "--format=%B",
    `${since ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: baseRoot, encoding: "utf8" }).trim()}..HEAD`
  )
);

const samples = new Map(
  names.map((name) => [name, { base: [] as number[], head: [] as number[] }])
);
/** The variants the base cannot run, and the ones that need no more runs. */
const fresh = new Set<string>();
const done = new Set<string>();
/** After this many runs each, a variant whose builds are as fast is let go. */
const ENOUGH = 6;

console.log(
  `Comparing ${names.length} variants of bench/${suite.file}, up to ${runs} runs each by each build.`
);
for (let round = 0; round < runs; round++) {
  for (const name of names) {
    if (done.has(name)) {
      continue;
    }
    const of = samples.get(name)!;
    // Turn and turn about, and each first in its turn.
    for (const build of round % 2 === 0 ? [base, head] : [head, base]) {
      if (build === head) {
        of.head.push(run(head, name));
      } else if (round > 0) {
        if (!fresh.has(name)) {
          of.base.push(run(base, name));
        }
      } else {
        const ms = first(name);
        if (ms === undefined) {
          fresh.add(name);
        } else {
          of.base.push(ms);
        }
      }
    }
    if (round + 1 >= ENOUGH && !fresh.has(name) && settled(of.base, of.head)) {
      done.add(name);
    }
  }
  console.log(
    `  round ${round + 1} of ${runs}: ${names.length - done.size} variants still running`
  );
}

const lines: Line[] = names.map((name) => {
  const variant = variants[name]!;
  const of = samples.get(name)!;
  const { unit } = inUnit(variant, 0);
  return {
    name,
    label: own.has(name)
      ? `${variant.label}, the base by its own bench`
      : variant.label,
    unit,
    verdict: judge(
      of.base.map((ms) => inUnit(variant, ms).value),
      of.head.map((ms) => inUnit(variant, ms).value),
      meant.has(name)
    ),
  };
});
const failed = failures(lines);
const report = [
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
].join("\n");
console.log(`\n${report}\n`);
if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
