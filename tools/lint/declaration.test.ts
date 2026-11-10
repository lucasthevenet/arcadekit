import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

// Runs the real oxlint, with this plugin's two rules, on small files of game code: the plugin
// is only what oxlint makes of it, so a test of its functions alone would show less. One run
// lints every case; each case is a file.

const repoDir = path.resolve(import.meta.dirname, "../..");

const header = `import { Asset, Content } from "arcadekit/content";
import * as Game from "arcadekit/game";
`;

/** Each case: the code, and the rule and a part of the message of each report it should get. */
const CASES: Readonly<
  Record<
    string,
    { readonly code: string; readonly reports: readonly (readonly string[])[] }
  >
> = {
  "a class with the name it is declared with": {
    code: `export class LevelSolved extends Game.Event("LevelSolved", {}) {}
export class Deposit extends Game.Command("Deposit") {}
export class JarFull extends Game.Rejection("JarFull") {}
export class Levels extends Content("Levels", { schema: 1, files: {} }) {}
export class Sheet extends Asset<number, never>()("Sheet") {}
export class Quoted extends Game.Event(\`Quoted\`) {}`,
    reports: [],
  },
  "a class declared under another name": {
    code: `export class LevelSolvd extends Game.Event("LevelSolved", {}) {}`,
    reports: [["named", 'The class LevelSolvd is declared as "LevelSolved"']],
  },
  "a builder that takes its types first, under another name": {
    code: `export class Sheeet extends Asset<number, never>()("Sheet") {}`,
    reports: [
      ["named", '`class Sheeet extends Asset<...>()("Sheeet", ...) {}`'],
    ],
  },
  "a name that is not a plain string": {
    code: `const name = "Deposit";
export class Deposit extends Game.Command(name) {}`,
    reports: [["named", "takes the class's own name as a plain string"]],
  },
  "a class with no name": {
    code: `export const JarFull = class extends Game.Rejection("JarFull") {};`,
    reports: [["named", "A declaration is a named class"]],
  },
  "a builder called outside a class": {
    code: `export const Hud = Game.Event("Hud", {});
export type Hud = typeof Hud.Type;`,
    reports: [["class", '`class Hud extends Game.Event("Hud", ...) {}`']],
  },
  "a builder that takes its types first, called outside a class": {
    code: `export const Sheet = Asset<number>()("Sheet");`,
    reports: [["class", '`class Sheet extends Asset<...>()("Sheet", ...) {}`']],
  },
  "a class that is no declaration": {
    code: `class Base {}
const make = (name: string) => class {
  static readonly made = name;
};
export class Other extends make("Another") {}
export class Sub extends Base {}`,
    reports: [],
  },
};

const dir = mkdtempSync(path.join(tmpdir(), "declaration-lint-"));

const fileOf = (name: string): string =>
  `${Object.keys(CASES).indexOf(name)}.ts`;

interface Diagnostic {
  readonly message: string;
  readonly code: string;
  readonly filename: string;
}

const lintAll = (): readonly Diagnostic[] => {
  writeFileSync(
    path.join(dir, ".oxlintrc.json"),
    JSON.stringify({
      jsPlugins: [path.join(import.meta.dirname, "declaration.ts")],
      rules: { "declaration/named": "error", "declaration/class": "error" },
    })
  );
  for (const [name, { code }] of Object.entries(CASES)) {
    writeFileSync(path.join(dir, fileOf(name)), `${header}\n${code}\n`);
  }
  const run = spawnSync(
    path.join(repoDir, "node_modules/.bin/oxlint"),
    ["-c", ".oxlintrc.json", "--format=json", "."],
    { cwd: dir, encoding: "utf-8" }
  );
  const { diagnostics } = JSON.parse(run.stdout) as {
    readonly diagnostics: readonly Diagnostic[];
  };
  return diagnostics.filter(({ code }) => code.startsWith("declaration("));
};

const diagnostics = lintAll();

describe("the declaration lint rules", () => {
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(Object.entries(CASES))("%s", (name, { reports }) => {
    const got = diagnostics.filter(
      ({ filename }) => path.basename(filename) === fileOf(name)
    );
    expect(got.map(({ code }) => code)).toStrictEqual(
      reports.map(([rule]) => `declaration(${rule})`)
    );
    for (const [index, [, part]] of reports.entries()) {
      expect(got[index]?.message).toContain(part);
    }
  });
});
