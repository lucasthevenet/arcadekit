import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { BUILDER_ENTRIES, entryBuilders } from "./declaration";

// Runs the real oxlint, with this plugin's rules, on small files of code: the plugin is only
// what oxlint makes of it, so a test of its functions alone would show less. One run lints every
// case; each case is a file. A game's cases get the rules a game's code gets, and the kit's
// cases the one rule for the kit's own builders, as oxlint.config.ts gives them.
//
// A new rule gets its cases in WRITTEN. A new builder gets its cases by being registered: FOUND
// has one for each builder of each entry in BUILDER_ENTRIES, in a game's file, in a file of the
// kit's src/ and in a test in the kit's test/.

const repoDir = path.resolve(import.meta.dirname, "../..");

const GAME_RULES = [
  "named",
  "class",
  "inferred",
  "plain-handler",
  "create-first",
];
const KIT_RULES = ["builder"];

/** Where the kit's package is, as tools/lint/declaration.ts finds a file of the kit. */
const KIT_DIR = "packages/arcadekit";

const gameHeader = `import { Asset, Content } from "arcadekit/content";
import * as Game from "arcadekit/game";
`;

interface Case {
  /**
   * Whose code it is: a game's, or the kit's own source. A file of the kit that declares a part
   * (a test, a test game) is written as a game's and held to a game's rules: it says where it
   * is with `at`.
   */
  readonly of: "game" | "kit";
  /**
   * For a file of the kit that declares a part: its folder, from the kit's package (`src/declared`,
   * or `test/declared` for a test). It imports an entry by the relative path of the entry's public
   * file.
   */
  readonly at?: string;
  /** What the file imports, when it is not a game's usual imports of the kit. */
  readonly imports?: string;
  readonly code: string;
  /** The rule and a part of the message of each report the code should get. */
  readonly reports: readonly (readonly [rule: string, part: string])[];
}

const WRITTEN: Readonly<Record<string, Case>> = {
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
  "a handler of a declaration that has no run": {
    of: "game",
    code: `export class Levels extends Content("Levels", {
  schema: 1,
  files: {},
  validate: async () => [],
}) {}`,
    reports: [
      [
        "plain-handler",
        "validate is async. A function in a Content definition is a plain function: what hosts it calls it and goes on, and waits for nothing. Have what it would wait for ready before it is called: an Effect loads it, in the field the definition has for that (an engine's `uses`, a Coop's `content`) or in the app, and the function is given the result. See .agents/skills/declarations/SKILL.md.",
      ],
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
  // The data fields sit between the handlers and `create`: a handler written above `create`
  // is one whatever follows it.
  "a simulation's create written below its other handlers": {
    of: "game",
    code: `export class Jar extends Game.Simulation("Jar", {
  step: (jar) => {
    jar.coins += 1;
  },
  apply: {
    Empty: (jar) => {
      jar.coins = 0;
    },
  },
  sample: { event: Hud, read: (jar) => ({ coins: jar.coins }) },
  input: Schema.Null,
  commands: [Empty],
  create: (config: Config, { seed }) => ({ coins: config.start + seed }),
}) {}`,
    reports: [
      [
        "create-first",
        "`step`, `apply` and `sample` are written above `create`. TypeScript types a simulation's state from what `create` returns, and types a handler written above it first: that handler's state, and the simulation's, can come out `unknown` with no error. Write `create` before `step`, `apply` and `sample`. See .agents/skills/declarations/SKILL.md.",
      ],
    ],
  },
  "a simulation's create written between two handlers, as a method and as a function":
    {
      of: "game",
      code: `export class Jar extends Game.Simulation("Jar", {
  input: Schema.Null,
  step(jar) {
    jar.coins += 1;
  },
  create(config: Config) {
    return { coins: config.start };
  },
  sample: { event: Hud, read: (jar) => ({ coins: jar.coins }) },
}) {}
export class Tin extends Game.Simulation("Tin", {
  input: Schema.Null,
  commands: [Empty],
  "apply": { Empty: () => {} },
  create: function (config: Config) {
    return { coins: config.start };
  },
  step: () => {},
}) {}`,
      reports: [
        ["create-first", "`step` is written above `create`."],
        ["create-first", "`apply` is written above `create`."],
      ],
    },
  // A key computed from a plain string is the same field to TypeScript, and is read as one. A
  // key computed from a name is not known here: Tin's `create` and Pot's `step` may be any field.
  "a simulation's create and handlers under computed keys": {
    of: "game",
    code: `export class Jar extends Game.Simulation("Jar", {
  input: Schema.Null,
  ["sample"]: { event: Hud, read: (jar) => ({ coins: jar.coins }) },
  [\`create\`]: (config: Config) => ({ coins: config.start }),
}) {}
export class Tin extends Game.Simulation("Tin", {
  input: Schema.Null,
  step: () => {},
  [create]: () => ({ coins: 0 }),
}) {}
export class Pot extends Game.Simulation("Pot", {
  input: Schema.Null,
  [step]: () => {},
  create: () => ({ coins: 0 }),
}) {}`,
    reports: [["create-first", "`sample` is written above `create`."]],
  },
  "a simulation's create that is a name, below a handler": {
    of: "game",
    code: `export class Jar extends Game.Simulation("Jar", {
  input: Schema.Null,
  step,
  sample: { event: Hud, read: hudSample },
  create: createJar,
}) {}
export class Tin extends Game.Simulation("Tin", {
  input: Schema.Null,
  step: (tin) => {
    tin.coins += 1;
  },
  create,
}) {}`,
    reports: [],
  },
  "a simulation's create written in place, first of the handlers": {
    of: "game",
    code: `export class Jar extends Game.Simulation("Jar", {
  create: (config: Config, { seed }) => ({ coins: config.start + seed }),
  input: Schema.Null,
  step: (jar) => {
    jar.coins += 1;
  },
  sample: { event: Hud, read: (jar) => ({ coins: jar.coins }) },
}) {}
export class Tin extends Game.Simulation("Tin", {
  input: Schema.Null,
  create() {
    return { coins: 0 };
  },
  step: () => {},
}) {}`,
    reports: [],
  },
  "only a simulation's data fields above its create": {
    of: "game",
    code: `export class Jar extends Game.Simulation("Jar", {
  stepSeconds: 1 / 64,
  input: Schema.Null,
  events: [Rattled],
  commands: [Empty],
  create: (config: Config, { seed }) => ({ coins: config.start + seed }),
  step: () => {},
  apply: { Empty: () => {} },
}) {}`,
    reports: [],
  },
  // Only a simulation's handlers are typed from its `create`. A Content has neither field, and
  // the last call is no builder's: both are written this way so that the case fails if the
  // rule forgets which builder it is for.
  "handlers in another builder's definition, which has no create to type them":
    {
      of: "game",
      code: `export class JarEngine extends Game.Engine("JarEngine", {
  simulation: Jar,
  view: (container) => view(container),
  input: (surface) => input(surface),
}) {}
export class Levels extends Content("Levels", {
  schema: 1,
  files: {},
  step: () => {},
  create: () => 1,
}) {}
const Simulation = (name: string, rules: object) => ({ name, rules });
export const made = Simulation("Made", { step: () => {}, create: () => 1 });`,
      reports: [],
    },
  "a simulation's builder imported under another name, with create below a handler":
    {
      of: "game",
      imports: `import { Simulation as Rules } from "arcadekit/game";
import * as Kit from "arcadekit/game/browser";`,
      code: `export class Jar extends Rules("Jar", {
  input: Schema.Null,
  step: () => {},
  create: () => ({ coins: 0 }),
}) {}
export class Tin extends Kit.Simulation("Tin", {
  input: Schema.Null,
  sample: { event: Hud, read: hudSample },
  step,
  create: () => ({ coins: 0 }),
}) {}`,
      reports: [
        ["create-first", "`step` is written above `create`."],
        ["create-first", "`sample` and `step` are written above `create`."],
      ],
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
  "a Coop, declared from an engine": {
    of: "game",
    imports: `import { Coop } from "arcadekit/net/browser";`,
    code: `export class JarCoop extends Coop("JarCoop", { engine: 1, hash: () => 0 }) {}
export class JarsCoop extends Coop("JarCoop", { engine: 1 }) {}
export const Made = Coop("Made", { engine: 1 });
export class Typed extends Coop<"Typed">("Typed", { picks: async () => [] }) {}`,
    reports: [
      ["named", 'The class JarsCoop is declared as "JarCoop"'],
      ["class", '`class Made extends Coop("Made", ...) {}`'],
      ["inferred", "Coop takes no type argument"],
      ["plain-handler", "picks is async"],
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
    static readonly madeName = name;
  };
};`,
    reports: [["builder", 'static readonly kind = "<Noun>" as const']],
  },
  "a builder whose kind the kit doesn't list": {
    of: "kit",
    // A noun no builder will have, so that registering a builder never breaks this case.
    code: `export interface UnlistedClass<Name extends string> {
  readonly kind: "Unlisted";
  readonly unlistedName: Name;
}
export const make = <const Name extends string>(name: Name): UnlistedClass<Name> =>
  class {
    static readonly kind = "Unlisted" as const;
    static readonly unlistedName: Name = name;
  } as unknown as UnlistedClass<Name>;`,
    reports: [
      [
        "builder",
        "\"Unlisted\" is not one of the kit's declarations. A new one is a new word of the kit's vocabulary: add its builder to DECLARATION_BUILDERS in tools/lint/declaration.ts, with its entry in BUILDER_ENTRIES there if no builder came from that entry before, and to DECLARATIONS in packages/arcadekit/test/style.test.ts",
      ],
    ],
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
  "a builder of the kit that throws when declared, and says so": {
    of: "kit",
    code: `export interface EventClass<Tag extends string> {
  readonly kind: "Event";
  readonly tag: Tag;
  readonly match: (cases: object) => void;
}
/**
 * A fact a run reports.
 *
 * Throws when
 * declared, for what the types let through: a tag that is empty.
 */
export const make = <const Tag extends string>(tag: Tag): EventClass<Tag> => {
  if (tag === "") {
    throw new Error("An event has a tag.");
  }
  return class {
    static readonly kind = "Event" as const;
    static readonly tag: Tag = tag;
    static readonly match = (cases: object) => {
      if (!(tag in cases)) {
        throw new Error("No case.");
      }
    };
  } as unknown as EventClass<Tag>;
};`,
    reports: [],
  },
  "a builder of the kit that throws when declared, and doesn't say so": {
    of: "kit",
    code: `export interface EventClass<Tag extends string> {
  readonly kind: "Event";
  readonly tag: Tag;
}
/** A fact a run reports. An empty tag is refused. */
export const make = <const Tag extends string>(tag: Tag): EventClass<Tag> => {
  for (const letter of tag) {
    if (letter === " ") {
      throw new Error("An event's tag is one word.");
    }
  }
  return class {
    static readonly kind = "Event" as const;
    static readonly tag: Tag = tag;
  } as unknown as EventClass<Tag>;
};`,
    reports: [
      [
        "builder",
        'The builder of Event throws when one is declared, and its doc comment doesn\'t say so. End the doc comment with what the builder refuses: "Throws when declared, for what the types let through: ...".',
      ],
    ],
  },
  "a builder of the kit that takes its types first, throws when declared and has no doc comment":
    {
      of: "kit",
      code: `export interface AssetClass<Name extends string, A> {
  readonly kind: "Asset";
  readonly assetName: Name;
  readonly load: A;
}
export const Asset =
  <A>() =>
  <const Name extends string>(name: Name): AssetClass<Name, A> => {
    if (name === "") {
      throw new Error("An asset has a name.");
    }
    return class {
      static readonly kind = "Asset" as const;
      static readonly assetName: Name = name;
      static readonly load = undefined;
    } as unknown as AssetClass<Name, A>;
  };`,
      reports: [
        ["builder", "The builder of Asset throws when one is declared"],
      ],
    },
  "a builder of the kit whose class throws only when one of its statics is called":
    {
      of: "kit",
      code: `export interface EventClass<Tag extends string> {
  readonly kind: "Event";
  readonly tag: Tag;
  readonly match: (cases: object) => void;
}
/** A fact a run reports. */
export const make = <const Tag extends string>(tag: Tag): EventClass<Tag> => {
  const check = (cases: object): void => {
    if (!(tag in cases)) {
      throw new Error("No case.");
    }
  };
  return class {
    static readonly kind = "Event" as const;
    static readonly tag: Tag = tag;
    static readonly match = check;
  } as unknown as EventClass<Tag>;
};`,
      reports: [],
    },
  // The rule's known limit: it sees a `throw` written in the builder's own body, and these two
  // throw as the part is declared from somewhere else. If either is ever reported, the rule
  // reaches further: say so in its header and in the guide's row for it.
  "a builder of the kit that throws when declared from a function it calls": {
    of: "kit",
    code: `export interface EventClass<Tag extends string> {
  readonly kind: "Event";
  readonly tag: Tag;
}
const refuseEmpty = (tag: string): void => {
  if (tag === "") {
    throw new Error("An event has a tag.");
  }
};
/** A fact a run reports. */
export const make = <const Tag extends string>(tag: Tag): EventClass<Tag> => {
  refuseEmpty(tag);
  return class {
    static readonly kind = "Event" as const;
    static readonly tag: Tag = tag;
  } as unknown as EventClass<Tag>;
};`,
    reports: [],
  },
  "a builder of the kit that throws when declared from a callback it passes": {
    of: "kit",
    code: `export interface EventClass<Tag extends string> {
  readonly kind: "Event";
  readonly tag: Tag;
}
/** A fact a run reports. */
export const make = <const Tag extends string>(tag: Tag): EventClass<Tag> => {
  [...tag].forEach((letter) => {
    if (letter === " ") {
      throw new Error("An event's tag is one word.");
    }
  });
  return class {
    static readonly kind = "Event" as const;
    static readonly tag: Tag = tag;
  } as unknown as EventClass<Tag>;
};`,
    reports: [],
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

/** How a file imports the builders of `entry` from `from`: as the namespace, or each by name. */
const importOf = (entry: string, from: string): string =>
  BUILDER_ENTRIES[entry] === "namespace"
    ? `import * as Game from "${from}";`
    : `import { ${[...(entryBuilders(entry)?.keys() ?? [])].join(", ")} } from "${from}";`;

/**
 * An entry's public file from the kit's src/, without its extension, as a file of the kit
 * imports it: `game/browser` for `arcadekit/game/browser`. Read here from the package's exports,
 * and not from the plugin, so the cases below hold the plugin to how the kit's files are written.
 */
const publicFileOf = (entry: string): string => {
  const { exports } = JSON.parse(
    readFileSync(path.join(repoDir, "packages/arcadekit/package.json"), "utf-8")
  ) as {
    readonly exports: Readonly<Record<string, { readonly source: string }>>;
  };
  const source = exports[entry.replace(/^arcadekit/u, ".")]?.source ?? "";
  return source.replace(/^\.\/src\//u, "").replace(/\.ts$/u, "");
};

/**
 * For each entry lint reads builders from and each builder it gives: a class declared under
 * another name, in a game's file, which imports the entry by its name, and in a file of the kit's
 * src/ and a test in its test/, which import the entry's public file by its relative path. Each is
 * reported under the builder's own name, so a builder that is registered is one the rules see,
 * from all three.
 */
const FOUND: Readonly<Record<string, Case>> = Object.fromEntries(
  Object.keys(BUILDER_ENTRIES).flatMap((entry) =>
    [...(entryBuilders(entry)?.values() ?? [])].flatMap((builder) => {
      const misnamed = {
        of: "game",
        code: `export class Misnamed extends ${builder}("Declared") {}`,
        reports: [
          [
            "named",
            `\`class Misnamed extends ${builder}("Misnamed", ...) {}\``,
          ],
        ],
      } as const;
      return [
        [
          `${builder} from ${entry}, in a game's file`,
          { ...misnamed, imports: importOf(entry, entry) },
        ],
        [
          `${builder} from ${entry}, in a file of the kit`,
          {
            ...misnamed,
            at: "src/declared",
            imports: importOf(entry, `../${publicFileOf(entry)}`),
          },
        ],
        [
          `${builder} from ${entry}, in a test of the kit`,
          {
            ...misnamed,
            at: "test/declared",
            imports: importOf(entry, `../../src/${publicFileOf(entry)}`),
          },
        ],
      ];
    })
  )
);

const CASES: Readonly<Record<string, Case>> = { ...WRITTEN, ...FOUND };

const dir = mkdtempSync(path.join(tmpdir(), "declaration-lint-"));

/** A case's file, from the folder oxlint runs in. */
const fileOf = (name: string): string => {
  const { of, at } = CASES[name] ?? {};
  const file = `${of}-${Object.keys(CASES).indexOf(name)}.ts`;
  return at === undefined ? file : `${KIT_DIR}/${at}/${file}`;
};

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
        { files: ["**/game-*.ts"], jsPlugins: [plugin], rules: on(GAME_RULES) },
        { files: ["kit-*.ts"], jsPlugins: [plugin], rules: on(KIT_RULES) },
      ],
    })
  );
  for (const [name, { of, imports, code }] of Object.entries(CASES)) {
    const file = path.join(dir, fileOf(name));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
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
      Object.values(WRITTEN).flatMap(({ reports }) =>
        reports.map(([rule]) => rule)
      )
    );
    expect(
      [...tested].toSorted(),
      "Each rule this test turns on has a case in WRITTEN that it reports, and each case's rule is one the test turns on: add the case, or the rule to GAME_RULES or KIT_RULES."
    ).toStrictEqual([...GAME_RULES, ...KIT_RULES].toSorted());
  });

  it("have a case for every builder of every entry, from a game, from the kit and from its tests", () => {
    const builders = Object.keys(BUILDER_ENTRIES).flatMap((entry) => [
      ...(entryBuilders(entry)?.values() ?? []),
    ]);
    expect(
      builders.length,
      "BUILDER_ENTRIES and DECLARATION_BUILDERS in tools/lint/declaration.ts give no builder, so this test found no case to make"
    ).toBeGreaterThan(0);
    expect(
      Object.keys(FOUND),
      "FOUND has three cases for each builder of each entry, one in a game's file, one in a file of the kit and one in a test of the kit, and two of them have the same name"
    ).toHaveLength(builders.length * 3);
  });

  it.each(Object.entries(CASES))("%s", (name, { reports }) => {
    const got = diagnostics
      .filter(
        ({ filename }) =>
          path.relative(dir, path.resolve(dir, filename)) ===
          path.normalize(fileOf(name))
      )
      .map(({ code, message }) => `${code}: ${message}`);
    const missing = reports.filter(
      ([rule, part]) =>
        !got.some(
          (report) =>
            report.startsWith(`declaration(${rule}): `) && report.includes(part)
        )
    );
    const reported =
      got.length === 0
        ? "It reported nothing."
        : `It reported:\n${got.join("\n")}`;
    expect(
      missing,
      `oxlint did not report what this case lists, each as [rule, part of the message]. ${reported}`
    ).toStrictEqual([]);
    expect(
      got,
      `oxlint reported more than the ${reports.length} this case lists. ${reported}`
    ).toHaveLength(reports.length);
  });
});
