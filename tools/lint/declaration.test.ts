import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

// Runs the real oxlint, with this plugin's rules, on small files of code: the plugin is only
// what oxlint makes of it, so a test of its functions alone would show less. One run lints every
// case; each case is a file. A game's cases get the rules a game's code gets, and the kit's
// cases the one rule for the kit's own builders, as oxlint.config.ts gives them.

const repoDir = path.resolve(import.meta.dirname, "../..");

const GAME_RULES = [
  "named",
  "class",
  "inferred",
  "plain-handler",
  "older-contract",
];
const KIT_RULES = ["builder"];

const gameHeader = `import { Asset, Content } from "arcadekit/content";
import * as Game from "arcadekit/game";
`;

interface Case {
  /** Whose code it is: a game's, or the kit's own source. */
  readonly of: "game" | "kit";
  /** What the file imports, when it is not a game's usual imports of the kit. */
  readonly imports?: string;
  readonly code: string;
  /** The rule and a part of the message of each report the code should get. */
  readonly reports: readonly (readonly [rule: string, part: string])[];
}

const CASES: Readonly<Record<string, Case>> = {
  "a class with the name it is declared with": {
    of: "game",
    code: `export class LevelSolved extends Game.Event("LevelSolved", {}) {}
export class Deposit extends Game.Command("Deposit") {}
export class JarFull extends Game.Rejection("JarFull") {}
export class Levels extends Content("Levels", { schema: 1, files: {} }) {}
export class Sheet extends Asset<number, never>()("Sheet") {}
export class Quoted extends Game.Event(\`Quoted\`) {}`,
    reports: [],
  },
  "a class declared under another name": {
    of: "game",
    code: `export class LevelSolvd extends Game.Event("LevelSolved", {}) {}`,
    reports: [["named", 'The class LevelSolvd is declared as "LevelSolved"']],
  },
  "a builder that takes its types first, under another name": {
    of: "game",
    code: `export class Sheeet extends Asset<number, never>()("Sheet") {}`,
    reports: [
      ["named", '`class Sheeet extends Asset<...>()("Sheeet", ...) {}`'],
    ],
  },
  "a name that is not a plain string": {
    of: "game",
    code: `const name = "Deposit";
export class Deposit extends Game.Command(name) {}`,
    reports: [["named", "takes the class's own name as a plain string"]],
  },
  "a class with no name": {
    of: "game",
    code: `export const JarFull = class extends Game.Rejection("JarFull") {};`,
    reports: [["named", "A declaration is a named class"]],
  },
  "a builder called outside a class": {
    of: "game",
    code: `export const Hud = Game.Event("Hud", {});
export type Hud = typeof Hud.Type;`,
    reports: [["class", '`class Hud extends Game.Event("Hud", ...) {}`']],
  },
  "a builder that takes its types first, called outside a class": {
    of: "game",
    code: `export const Sheet = Asset<number>()("Sheet");`,
    reports: [["class", '`class Sheet extends Asset<...>()("Sheet", ...) {}`']],
  },
  "a class that is no declaration": {
    of: "game",
    code: `class Base {}
const make = (name: string) => class {
  static readonly made = name;
};
export class Other extends make("Another") {}
export class Sub extends Base {}`,
    reports: [],
  },
  "a builder given a type argument": {
    of: "game",
    code: `export class Jar extends Game.Simulation<"Jar", number>("Jar", {
  create: () => ({ coins: 0 }),
  step: () => {},
}) {}`,
    reports: [["inferred", "Game.Simulation takes no type argument"]],
  },
  "the types a builder takes first": {
    of: "game",
    code: `export class Sheet extends Asset<number, Error>()("Sheet", {
  release: (sheet) => sheet,
}) {}`,
    reports: [],
  },
  "a handler that is async, and one that is a generator": {
    of: "game",
    code: `export class Jar extends Game.Simulation("Jar", {
  create: async () => ({ coins: 0 }),
  *step() {
    yield 1;
  },
  apply: {
    Deposit: async (jar) => jar,
    Empty: (jar) => jar,
  },
  sample: { read: (jar) => jar },
}) {}`,
    reports: [
      ["plain-handler", "create is async"],
      ["plain-handler", "step is a generator"],
      ["plain-handler", "Deposit is async"],
    ],
  },
  "an Effect a definition holds, made with a generator": {
    of: "game",
    code: `export class JarEngine extends Game.Engine("JarEngine", {
  uses: { sheet: Effect.gen(function* () { return yield* load; }) },
  view: (container, { sheet }) => view(container, sheet),
  input: (surface) => input(surface),
}) {}`,
    reports: [],
  },
  "the older contract, imported by name": {
    of: "game",
    code: `import { makeGameEngine, combineViews } from "arcadekit/runtime/browser";
import type { GameSimulation, StepInput } from "arcadekit/runtime";
export type { GameDefinition } from "arcadekit/runtime/browser";
export const made = [makeGameEngine, combineViews];
export type Old = [GameSimulation<1, 2, 3, 4>, StepInput<1>];`,
    reports: [
      ["older-contract", "makeGameEngine is the older contract"],
      ["older-contract", "Declare a Game.Simulation in its place"],
      ["older-contract", "GameDefinition is the older contract"],
    ],
  },
  "the older contract, through an entry's namespace": {
    of: "game",
    code: `import * as Runtime from "arcadekit/runtime/browser";
export const made = [Runtime.makeGameEngine, Runtime.combineViews];
export type Old = Runtime.GameEngine<1, 2, 3>;`,
    reports: [
      ["older-contract", "makeGameEngine is the older contract"],
      ["older-contract", "GameEngine is the older contract"],
    ],
  },
  "the same names from somewhere else": {
    of: "game",
    code: `import { makeGameEngine } from "./engine";
import * as Other from "other-kit";
export const made = [makeGameEngine, Other.makeGameEngine];`,
    reports: [],
  },
  "a builder imported by name, or under another name": {
    of: "game",
    imports: `import { Event, Simulation as Rules } from "arcadekit/game";
import { Content as GameContent } from "arcadekit/content";`,
    code: `export class Solved extends Event("LevelSolved") {}
export const Hud = Event("Hud");
export class Jar extends Rules<"Jar">("Jar", { step: async () => {} }) {}
export class Levels extends GameContent("Stages", { schema: 1, files: {} }) {}`,
    reports: [
      ["named", 'The class Solved is declared as "LevelSolved"'],
      ["class", '`class Hud extends Game.Event("Hud", ...) {}`'],
      ["inferred", "Game.Simulation takes no type argument"],
      ["plain-handler", "step is async"],
      ["named", 'The class Levels is declared as "Stages"'],
    ],
  },
  "an entry imported under another namespace name": {
    of: "game",
    imports: `import * as Kit from "arcadekit/game/browser";`,
    code: `export class Paused extends Kit.Command("Resumed") {}
export class JarEngine extends Kit.Engine("JarEngine", { view: async () => 1 }) {}`,
    reports: [
      ["named", 'The class Paused is declared as "Resumed"'],
      ["plain-handler", "view is async"],
    ],
  },
  "functions of the app's own that are only named like a builder": {
    of: "game",
    imports: `import { defineTaggedUnion } from "./union";`,
    code: `const Content = (text: string): string => text.trim();
const Asset = (url: string) => ({ url });
const Game = defineTaggedUnion({ Event: (name: string) => name });
export const made = [Content(" Push Puzzle "), Asset("sprites.json"), Game.Event("moved")];`,
    reports: [],
  },
  "a builder's types kept apart from the call that names the part": {
    of: "game",
    code: `const Sheet = Asset<number, Error>();
export class Boxes extends Sheet("Walls") {}`,
    reports: [["class", "Give Asset its types where the part is declared"]],
  },
  "a class that extends a declaration": {
    of: "game",
    code: `export class Solved extends Game.Event("Solved") {}
export class Failed extends Solved {}`,
    reports: [["named", "Failed extends the declaration Solved"]],
  },
  "a base named before its class extends it, as the kit's own files write it": {
    of: "game",
    code: `const SolvedBase = Game.Event("Solved");
export class Solved extends SolvedBase {}
const OtherBase = Game.Event("Another");
export class Other extends OtherBase {}
const Twice = Game.Event("Twice");
export class Twice1 extends Twice {}
export class Twice2 extends Twice {}`,
    reports: [
      ["named", 'The class Other is declared as "Another"'],
      ["named", 'The class Twice1 is declared as "Twice"'],
      ["named", 'The class Twice2 is declared as "Twice"'],
      ["class", "2 classes extend Twice"],
    ],
  },
  "a builder's call with a cast round it, and a name written `as const`": {
    of: "game",
    code: `export class Cast extends (Game.Event("Cast") as never) {}
export class Kept extends Game.Event("Kept" as const) {}`,
    reports: [["class", "Extend Game.Event(...) itself"]],
  },
  "two builders of one kind in one file of the kit": {
    of: "kit",
    code: `export interface EventClass<Tag extends string> {
  readonly kind: "Event";
  readonly tag: Tag;
}
export const make = <const Tag extends string>(tag: Tag): EventClass<Tag> =>
  class {
    static readonly kind = "Event" as const;
    static readonly tag: Tag = tag;
  } as unknown as EventClass<Tag>;
export const Notice = <const Tag extends string>(tag: Tag): EventClass<Tag> =>
  class {
    static readonly kind = "Event" as const;
    static readonly tag: Tag = tag;
  } as unknown as EventClass<Tag>;`,
    reports: [["builder", 'This file has another builder of kind "Event"']],
  },
  "a builder of the kit": {
    of: "kit",
    code: `export interface EventClass<Tag extends string> {
  readonly kind: "Event";
  readonly tag: Tag;
}
export const make = <const Tag extends string>(tag: Tag): EventClass<Tag> => {
  const Base = base(tag);
  return class extends Base {
    static readonly kind = "Event" as const;
    static readonly tag: Tag = tag;
  } as unknown as EventClass<Tag>;
};`,
    reports: [],
  },
  "a builder of the kit that takes its types first": {
    of: "kit",
    code: `export interface AssetClass<Name extends string, A> {
  readonly kind: "Asset";
  readonly assetName: Name;
  readonly load: A;
}
export const Asset =
  <A>() =>
  <const Name extends string>(name: Name): AssetClass<Name, A> =>
    class {
      static readonly kind = "Asset" as const;
      static readonly assetName: Name = name;
      static readonly load = undefined;
    } as unknown as AssetClass<Name, A>;`,
    reports: [],
  },
  "a function that returns a class with no kind": {
    of: "kit",
    code: `export const make = <const Name extends string>(name: Name): object => {
  return class {
    static readonly saveName = name;
  };
};`,
    reports: [["builder", 'static readonly kind = "<Noun>" as const']],
  },
  "a builder whose kind the kit doesn't list": {
    of: "kit",
    code: `export interface SaveClass<Name extends string> {
  readonly kind: "Save";
  readonly saveName: Name;
}
export const make = <const Name extends string>(name: Name): SaveClass<Name> =>
  class {
    static readonly kind = "Save" as const;
    static readonly saveName: Name = name;
  } as unknown as SaveClass<Name>;`,
    reports: [["builder", '"Save" is not one of the kit\'s declarations']],
  },
  "a builder that keeps the name in `name`, types it `string` and extends a call":
    {
      of: "kit",
      code: `export interface EventClass {
  readonly kind: "Event";
  readonly tag: string;
}
export const make = (tag: string) =>
  class extends base(tag) {
    static readonly kind = "Event" as const;
    static readonly name = tag;
  };`,
      reports: [
        ["builder", "typed by a type parameter"],
        ["builder", "return type is written out: `EventClass<...>`"],
        ["builder", "keeps the name it was declared with"],
        ["builder", "Name the base before the class extends it"],
        ["builder", "A class already has a `name`"],
        [
          "builder",
          "EventClass has `tag`, which the builder's class never sets",
        ],
        ["builder", "sets `name`, which EventClass doesn't have"],
      ],
    },
  "a builder with no interface, or one that says another kind": {
    of: "kit",
    code: `interface EventClass<Tag extends string> {
  readonly kind: "Event";
  readonly tag: Tag;
}
export interface CommandClass<Tag extends string> {
  readonly kind: "Event";
  readonly label: Tag;
}
export const makeEvent = <const Tag extends string>(tag: Tag): EventClass<Tag> =>
  class {
    static readonly kind = "Event" as const;
    static readonly tag: Tag = tag;
  } as unknown as EventClass<Tag>;
export const makeCommand = <const Tag extends string>(tag: Tag): CommandClass<Tag> =>
  class {
    static readonly kind = "Command" as const;
    static readonly tag: Tag = tag;
  } as unknown as CommandClass<Tag>;`,
    reports: [
      ["builder", "CommandClass says what its class is"],
      ["builder", "CommandClass has the declared name"],
      [
        "builder",
        "CommandClass has `label`, which the builder's class never sets",
      ],
      ["builder", "sets `tag`, which CommandClass doesn't have"],
      ["builder", "This file exports no interface EventClass"],
    ],
  },
  "a class of the kit that no function returns": {
    of: "kit",
    code: `export const Fixed = class {
  static readonly made = 1;
};
export class Named {}`,
    reports: [],
  },
};

const dir = mkdtempSync(path.join(tmpdir(), "declaration-lint-"));

const fileOf = (name: string): string =>
  `${CASES[name]?.of}-${Object.keys(CASES).indexOf(name)}.ts`;

interface Diagnostic {
  readonly message: string;
  readonly code: string;
  readonly filename: string;
}

const on = (rules: readonly string[]): Readonly<Record<string, string>> =>
  Object.fromEntries(rules.map((rule) => [`declaration/${rule}`, "error"]));

const lintAll = (): readonly Diagnostic[] => {
  const plugin = path.join(import.meta.dirname, "declaration.ts");
  writeFileSync(
    path.join(dir, ".oxlintrc.json"),
    JSON.stringify({
      overrides: [
        { files: ["game-*.ts"], jsPlugins: [plugin], rules: on(GAME_RULES) },
        { files: ["kit-*.ts"], jsPlugins: [plugin], rules: on(KIT_RULES) },
      ],
    })
  );
  for (const [name, { of, imports, code }] of Object.entries(CASES)) {
    writeFileSync(
      path.join(dir, fileOf(name)),
      `${imports ?? (of === "game" ? gameHeader : "")}\n${code}\n`
    );
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

  it("have a case for every rule", () => {
    const tested = new Set(
      Object.values(CASES).flatMap(({ reports }) =>
        reports.map(([rule]) => rule)
      )
    );
    expect([...tested].toSorted()).toStrictEqual(
      [...GAME_RULES, ...KIT_RULES].toSorted()
    );
  });

  it.each(Object.entries(CASES))("%s", (name, { reports }) => {
    const got = diagnostics
      .filter(({ filename }) => path.basename(filename) === fileOf(name))
      .map(({ code, message }) => `${code}: ${message}`);
    const missing = reports.filter(
      ([rule, part]) =>
        !got.some(
          (report) =>
            report.startsWith(`declaration(${rule}): `) && report.includes(part)
        )
    );
    expect(missing).toStrictEqual([]);
    expect(got).toHaveLength(reports.length);
  });
});
