// Compiles the `ts` blocks of the site's own pages (src/content/docs/) against the packages as they are in this
// checkout, so that the code a page shows is code that compiles.
//
//   pnpm --filter @arcadekit/website snippets
//
// - A block is a program of its own: it imports what it uses.
// - A block with a title, ` ```ts title="rules.ts" `, is that file of its page. Starlight shows the
//   title over the block. Another block of the page can import it (`import { Coin } from
//   "./rules.ts"`), and a later block with the same title adds to the end of it.
// - A block fenced ` ```ts sketch ` is a sketch, with `/* … */` where a game's own code goes: it
//   is highlighted as TypeScript and nothing compiles it.
//
// The blocks are written to `.snippets/`, a folder for each page, and compiled there with the
// site's own dependencies, which name both packages, and held to the rules of
// tooling/lint/plugin.ts that a game's code is held to. An error is reported at the page and line
// it is on. Then the files whose title ends in `.test.ts` are run, with the repository's Vitest:
// a page that shows a test shows one that passes.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const site = path.resolve(import.meta.dirname, "..");
const root = path.resolve(site, "..");
/** The site's own pages, relative to the repository's root. */
const DOCS = "website/src/content/docs";
const out = path.join(site, ".snippets");

const pages = readdirSync(path.join(root, DOCS), { recursive: true })
  .map((file) => String(file).split(path.sep).join("/"))
  .filter((file) => file.endsWith(".md"))
  .toSorted();

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** For each written file, the blocks it is made of: where each starts in the file and on its page. */
const origins = new Map();
let blocks = 0;

const write = (file, page, start, lines) => {
  const absolute = path.join(out, file);
  const segments = origins.get(file) ?? [];
  const offset = existsSync(absolute)
    ? readFileSync(absolute, "utf-8").split("\n").length - 1
    : 0;
  segments.push({ page: `${DOCS}/${page}`, start, offset });
  origins.set(file, segments);
  mkdirSync(path.dirname(absolute), { recursive: true });
  appendFileSync(absolute, `${lines.join("\n")}\n`);
};

for (const page of pages) {
  const folder = page.replace(/\.md$/u, "");
  const lines = readFileSync(path.join(root, DOCS, page), "utf-8").split("\n");
  let block;
  let untitled = 0;
  lines.forEach((line, index) => {
    if (block === undefined) {
      const open = /^```ts(?<meta>\s.*)?$/u.exec(line);
      if (open !== null && !/\bsketch\b/u.test(open.groups.meta ?? "")) {
        const title = /title="(?<title>[^"]+)"/u.exec(open.groups.meta ?? "")
          ?.groups.title;
        block = { start: index + 2, title, lines: [] };
      }
      return;
    }
    if (/^```\s*$/u.test(line)) {
      blocks++;
      untitled += block.title === undefined ? 1 : 0;
      const name = block.title ?? `block-${untitled}.ts`;
      write(`${folder}/${name}`, page, block.start, block.lines);
      block = undefined;
      return;
    }
    block.lines.push(line);
  });
}

if (blocks === 0) {
  console.log("The site's pages have no blocks to compile.");
  process.exit(0);
}

// Every file is a module of its own, whether or not it imports anything.
for (const file of origins.keys()) {
  appendFileSync(path.join(out, file), "export {};\n");
}

writeFileSync(
  path.join(out, "tsconfig.json"),
  JSON.stringify(
    {
      extends: "../../tsconfig.base.json",
      compilerOptions: {
        // The repository's own resolution, NodeNext, which a game's tsconfig may have too: a
        // page's files import each other by their whole name, as `import { Coin } from
        // "./rules.ts"`, which a bundler takes as well.
        lib: ["ES2023", "DOM", "DOM.Iterable"],
        types: ["node"],
      },
      include: ["**/*.ts"],
    },
    null,
    2
  )
);

const tsc = spawnSync("tsc", ["-p", out, "--pretty", "false"], {
  cwd: site,
  encoding: "utf-8",
  shell: process.platform === "win32",
});

/** Where a line of a written file is on its page. */
const originOf = (file, line) => {
  const segments = origins.get(file) ?? [];
  const segment = segments.findLast((candidate) => candidate.offset < line);
  return (
    segment && `${segment.page}:${segment.start + line - 1 - segment.offset}`
  );
};

const ERROR =
  /^(?:.*[/\\])?\.snippets[/\\](?<file>[^(]+)\((?<line>\d+),\d+\): (?<message>.*)$/u;
const errors = `${tsc.stdout ?? ""}${tsc.stderr ?? ""}`
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => {
    const match = ERROR.exec(line);
    const file = match?.groups.file.split(path.sep).join("/");
    const origin = file && originOf(file, Number(match.groups.line));
    return origin ? `${origin}: ${match.groups.message}` : line;
  });

if (tsc.status !== 0) {
  console.error(errors.join("\n"));
  console.error(
    `\nThe blocks of the site's pages do not compile (${blocks} checked).`
  );
  process.exit(1);
}
console.log(`${blocks} blocks of the site's pages compile.`);

// Oxlint walks past a folder whose name starts with a dot, so it is given each file.
const oxlintrc = path.join(out, ".oxlintrc.json");
writeFileSync(
  oxlintrc,
  JSON.stringify({
    categories: { correctness: "off" },
    jsPlugins: [path.join(root, "tooling/lint/plugin.ts")],
    rules: { "arcadekit/no-empty-payload": "error" },
  })
);
const oxlint = spawnSync(
  "oxlint",
  ["-c", oxlintrc, "--format", "unix", ...origins.keys()],
  { cwd: out, encoding: "utf-8", shell: process.platform === "win32" }
);
if (oxlint.status !== 0) {
  const PROBLEM = /^(?<file>[^:]+):(?<line>\d+):\d+: (?<message>.*)$/u;
  const problems = `${oxlint.stdout ?? ""}${oxlint.stderr ?? ""}`
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const match = PROBLEM.exec(line);
      const origin =
        match && originOf(match.groups.file, Number(match.groups.line));
      return origin ? `${origin}: ${match.groups.message}` : line;
    });
  console.error(problems.join("\n"));
  console.error(
    `\nThe blocks of the site's pages break a rule of arcadekit's.`
  );
  process.exit(1);
}

const tests = [...origins.keys()].filter((file) => file.endsWith(".test.ts"));
if (tests.length > 0) {
  const vitest = spawnSync(
    "vitest",
    ["run", ...tests.map((file) => path.join(out, file))],
    { cwd: root, stdio: "inherit", shell: process.platform === "win32" }
  );
  if (vitest.status !== 0) {
    console.error(`\nThe tests of the site's pages fail: ${tests.join(", ")}.`);
    process.exit(1);
  }
}
