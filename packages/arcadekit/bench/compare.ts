/**
 * Did a change make the storage core slower? Runs the variants of
 * `bench/core.ts` for two checkouts of the repository, the base and this
 * one, turn and turn about, and says for each whether this one is slower
 * by more than the noise. It ends with a failure if any is, unless a
 * commit of the change says it meant to.
 *
 *   pnpm --filter arcadekit bench:compare <base checkout> [options]
 *
 *   --runs <n>        runs of each variant by each build: 15 when left out
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
 * Both builds run this checkout's `bench/core.ts`, which is copied into
 * the base for as long as the comparison lasts, under a name of its own,
 * so that the two are asked the same thing and the base is left as it was
 * found; a variant the base cannot run is new, and compared with nothing.
 * Each run is a process of its own. `bench/verdict.ts` holds the rule, and
 * says why it is the rule.
 *
 * A commit that slows a variant on purpose says so in its message, and the
 * check then reports the variant and does not fail on it:
 *
 *   Bench-slower: each, eachMany
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inUnit, variants } from "./core";
import {
  CHANCE,
  failures,
  FLOOR,
  judge,
  onPurpose,
  settled,
  table,
} from "./verdict";
import type { Line } from "./verdict";

const here = path.dirname(fileURLToPath(import.meta.url));
const head = path.resolve(here, "..");

const usage = (problem: string): never => {
  console.error(
    `${problem}\n\nUsage: pnpm --filter arcadekit bench:compare <base checkout> [--runs <n>] [--only <a,b,...>] [--since <commit>]`
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
const runs = Number(option("--runs") ?? 15);
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
// there under a name that is no file of the base's, and taken away again
// however the comparison ends. A checkout left with a file of its own
// changed would refuse to be moved to another commit.
const ASKED = "core.compared.ts";
const asked = path.join(base, "bench", ASKED);
copyFileSync(path.join(head, "bench", "core.ts"), asked);
process.on("exit", () => {
  rmSync(asked, { force: true });
});

/** One run of a variant by a build: the median milliseconds of a pass. */
const run = (build: string, name: string): number =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "tsx", `bench/${build === base ? ASKED : "core.ts"}`, name],
      { cwd: build, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    )
      .trim()
      .split("\n")
      .pop()!
  ) as number;

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
  `Comparing ${names.length} variants of bench/core.ts, up to ${runs} runs each by each build.`
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
      } else if (!fresh.has(name)) {
        try {
          of.base.push(run(base, name));
        } catch (error) {
          if (round > 0) {
            throw error;
          }
          fresh.add(name);
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
    label: variant.label,
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
    ? "### The storage core is no slower"
    : `### The storage core is slower: ${failed.join(", ")}`,
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
