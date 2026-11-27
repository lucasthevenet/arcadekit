/**
 * What a comparison of two checkouts of the repository does, whichever
 * package's benchmark it compares: `bench/compare.ts` here, for the storage
 * core and an app's stages, and `@arcadekit/three`'s `bench/compare.ts`,
 * for the loops that draw. Each is this, its variants, and a rule of
 * `bench/verdict.ts`.
 *
 * It runs the variants of a suite for the base and for this checkout, turn
 * and turn about, and each run is a process of its own: V8 optimises a call
 * site for the functions it has seen there, so variants run one after
 * another in one process make the later ones look slower than they are.
 *
 * The base is a second checkout of the repository with its dependencies
 * installed, at the commit to compare with:
 *
 *   git worktree add ../base origin/next
 *   (cd ../base && pnpm install --frozen-lockfile)
 *
 * Both builds run this checkout's file of the suite, which is copied into
 * the base for as long as the comparison lasts, under a name of its own, so
 * that the two are asked the same thing and the base is left as it was
 * found. A variant that uses what the base's source does not have, as one
 * does once a change to what a game writes has rewritten it, is run in the
 * base from the base's own file, and the report says so: the two then do
 * the same work as far as the change's diff of the variant shows. A variant
 * the base cannot run either way is new, and compared with nothing.
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

import { onPurpose } from "./verdict.ts";

/** After this many runs each, a variant whose builds are as fast is let go. */
export const ENOUGH = 6;

export interface Suite<Run> {
  /**
   * The file of the package's `bench/` that runs the variant named on its
   * command line, and prints what it measured as JSON, on its last line.
   */
  readonly file: string;
  /** The files of `bench/` that `file` imports, copied into the base with it. */
  readonly imports?: readonly string[];
  readonly variants: Readonly<Record<string, { readonly label: string }>>;
  /** How many runs of each variant each build makes, unless told. */
  readonly runs: number;
  /** A run, from what its process printed. */
  readonly read: (printed: unknown) => Run;
  /**
   * Whether more runs would not tell the builds apart, asked after `ENOUGH`
   * runs each. With none, every variant makes every run.
   */
  readonly settled?: (base: readonly Run[], head: readonly Run[]) => boolean;
}

export interface Compared<Run> {
  readonly name: string;
  /** The variant's label, and whether the base ran it by its own bench. */
  readonly label: string;
  /** The base's runs: none when it could not run the variant, which is new. */
  readonly base: readonly Run[];
  readonly head: readonly Run[];
  /** Whether a commit of the change says it slows the variant on purpose. */
  readonly meant: boolean;
}

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);

/**
 * Runs the variants of one of `suites`, chosen with `--suite` when there are
 * several, for the base checkout named on the command line and for this
 * one, and hands back each variant's runs by each.
 */
export const compare = <Run, S extends Suite<Run>>(options: {
  /** How the comparison is run, for its usage: `pnpm --filter arcadekit bench:compare`. */
  readonly command: string;
  /** The package's folder in a checkout: `packages/arcadekit`. */
  readonly folder: string;
  /** Node's options for a run, ahead of the file: `--import tsx`. */
  readonly node: readonly string[];
  /** The suites by name: the first is the one compared unless told. */
  readonly suites: Readonly<Record<string, S>>;
}): { readonly suite: S; readonly compared: Compared<Run>[] } => {
  const { command, folder, node, suites } = options;
  const several = Object.keys(suites).length > 1;
  const usage = (problem: string): never => {
    console.error(
      `${problem}\n\nUsage: ${command} <base checkout>${several ? ` [--suite ${Object.keys(suites).join("|")}]` : ""} [--runs <n>] [--only <a,b,...>] [--since <commit>]`
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
  const suiteName =
    (several ? option("--suite") : undefined) ?? Object.keys(suites)[0]!;
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
    usage(`${command} is given one checkout to compare with.`);
  }
  // A path that is not absolute is from where the command was typed, which
  // under pnpm is not where the script runs.
  const baseRoot = path.resolve(
    process.env.INIT_CWD ?? process.cwd(),
    args[0]!
  );
  const head = path.join(repository, folder);
  const base = path.join(baseRoot, folder);
  if (!existsSync(path.join(base, "bench"))) {
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

  // The base is asked what this checkout asks: its copy of the suite's
  // files, kept there under names that are no files of the base's, and
  // taken away again however the comparison ends. A checkout left with a
  // file of its own changed would refuse to be moved to another commit. A
  // copy imports the copies of the others.
  const compared = (file: string): string =>
    file.replace(/\.ts$/u, ".compared.ts");
  const files = [suite.file, ...(suite.imports ?? [])];
  const copies = files.map((file) => ({
    at: path.join(base, "bench", compared(file)),
    text: files.reduce(
      (text, imported) =>
        text.replaceAll(`"./${imported}"`, `"./${compared(imported)}"`),
      readFileSync(path.join(head, "bench", file), "utf8")
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
   * The variants the base runs from its own file of the suite, since it
   * cannot run this checkout's: the change rewrote them for what a game now
   * writes.
   */
  const own = new Set<string>();

  /** One run of a variant by a build. */
  const run = (build: string, name: string): Run =>
    suite.read(
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            ...node,
            `bench/${build === base && !own.has(name) ? compared(suite.file) : suite.file}`,
            name,
          ],
          { cwd: build, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        )
          .trim()
          .split("\n")
          .pop()!
      )
    );

  /**
   * The base's first run of a variant: of this checkout's file, or else of
   * the base's own, or none when neither runs, and the variant is new.
   */
  const first = (name: string): Run | undefined => {
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

  const meant = onPurpose(
    execFileSync(
      "git",
      [
        "log",
        "--format=%B",
        `${since ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: baseRoot, encoding: "utf8" }).trim()}..HEAD`,
      ],
      { cwd: repository, encoding: "utf8" }
    )
  );

  const samples = new Map(
    names.map((name) => [name, { base: [] as Run[], head: [] as Run[] }])
  );
  /** The variants the base cannot run, and the ones that need no more runs. */
  const fresh = new Set<string>();
  const done = new Set<string>();

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
          const ran = first(name);
          if (ran === undefined) {
            fresh.add(name);
          } else {
            of.base.push(ran);
          }
        }
      }
      if (
        round + 1 >= ENOUGH &&
        !fresh.has(name) &&
        suite.settled?.(of.base, of.head) === true
      ) {
        done.add(name);
      }
    }
    console.log(
      `  round ${round + 1} of ${runs}: ${names.length - done.size} variants still running`
    );
  }

  return {
    suite,
    compared: names.map((name) => ({
      name,
      label: own.has(name)
        ? `${variants[name]!.label}, the base by its own bench`
        : variants[name]!.label,
      ...samples.get(name)!,
      meant: meant.has(name),
    })),
  };
};

/**
 * Prints the report, adds it to the summary of a step of GitHub's when it
 * runs in one, and ends the comparison: with a failure if `failed` names
 * any variant.
 */
export const report = (text: string, failed: readonly string[]): never => {
  console.log(`\n${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
};
