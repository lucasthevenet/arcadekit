import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import plugin from "./plugin.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const outside = `import { HashMap } from "effect";
import * as HashSet from "effect/HashSet";
let n = 0;
const cache = new Map();
const list = [];
const obj = { a: { b: 0 } };
`;

const kinds = {
  "System.tick": (body: string) =>
    `System.tick("Move", function* () {\n${body}\n});`,
  "State.onEnter": (body: string) =>
    `State.onEnter(Phase, "play", "Enter", function* () {\n${body}\n});`,
  "State.onExit": (body: string) =>
    `State.onExit(Phase, "play", "Exit", function* () {\n${body}\n});`,
  "Action.handler": (body: string) =>
    `Action.handler(Go, function* (payload) {\n${body}\n});`,
  "Plugin.make's setup": (body: string) =>
    `Plugin.make("P", { setup: Effect.gen(function* () {\n${body}\n}) });`,
};

const changesOutside = [
  "n++;",
  "n += 1;",
  "n = 2;",
  "cache.set(1, 2);",
  "list.push(1);",
  "obj.a.b = 1;",
  "delete obj.a;",
  "const later = () => { n++; };",
];

const changesNothingOutside = [
  "let m = 0; m++; const own = []; own.push(1);",
  "const later = () => { let k = 0; k++; const own = new Map(); own.set(1, 2); };",
  "const map = HashMap.set(HashMap.empty(), 1, 2); HashSet.add(HashSet.empty(), 1);",
  "const read = cache.get(1) + list.length + obj.a.b + n;",
];

new RuleTester().run("no-outside-state", plugin.rules["no-outside-state"], {
  valid: [
    ...Object.entries(kinds).flatMap(([kind, wrap]) =>
      changesNothingOutside.map((body: string) => ({
        name: `${kind}: ${body}`,
        code: outside + wrap(body),
      }))
    ),
    {
      name: "an action's handler changes its payload",
      code: outside + kinds["Action.handler"]("payload = 1; payload.x = 1;"),
    },
    {
      name: "code that is not the tick's changes what is outside it",
      code: `${outside}function plain() {\n${changesOutside.join("\n")}\n}\nEffect.gen(function* () { n++; list.push(1); });`,
    },
  ],
  invalid: Object.entries(kinds).flatMap(([kind, wrap]) =>
    changesOutside.map((body: string) => ({
      name: `${kind}: ${body}`,
      code: outside + wrap(body),
      errors: [
        {
          message:
            /^This changes (n|cache|list|obj), which is declared outside the code of the tick/u,
        },
      ],
    }))
  ),
});

const between = {
  "System.frame": (body: string) =>
    `System.frame("Draw", function* () {\n${body}\n});`,
  "System.input": (body: string) =>
    `System.input("Listen", function* () {\n${body}\n});`,
};

new RuleTester().run(
  "no-outside-state, between ticks",
  plugin.rules["no-outside-state"],
  {
    valid: Object.entries(between).flatMap(([kind, wrap]) =>
      [
        // Drawing changes what is outside the game, which is what a frame is for.
        "cache.set(1, 2); list.push(1); obj.a.b = 1; context.fillRect(0, 0, n, n);",
        "let m = 0; m++; const kept = yield* Kept; kept.angle += 1;",
      ].map((body) => ({
        name: `${kind}: ${body}`,
        code: outside + wrap(body),
      }))
    ),
    invalid: Object.entries(between).flatMap(([kind, wrap]) =>
      ["n++;", "n += 1;", "n = 2;"].map((body) => ({
        name: `${kind}: ${body}`,
        code: outside + wrap(body),
        errors: [
          {
            message:
              /^This sets n, a variable declared outside the frame or input system it is in: every app of the game shares it.*in a System\.local/u,
          },
        ],
      }))
    ),
  }
);

new RuleTester().run("id-casts", plugin.rules["id-casts"], {
  valid: [
    {
      name: "an id from the world, and a number that is no id",
      code: "const entity = world.spawn(); const n = 3 as number; const kept: Entity.Ref = entity;",
      filename: "game.ts",
    },
  ],
  invalid: [
    "n as Entity",
    "n as unknown as Entity",
    "ref as Entity.Ref",
    "ids as Entity[]",
    "spawned as Spawned",
    "column as EntityColumn",
    "<Entity>n",
    "schema as unknown as Schema.Codec<Entity, number>",
  ]
    .map((cast) => ({
      name: cast,
      code: `const id = ${cast};`,
      filename: "game.ts",
      errors: [{ message: /^This asserts that a value is an entity's id/u }],
    }))
    .concat({
      name: "an empty list of ids, which is given its type instead",
      code: `const Party = View.define("game/Party", [] as Entity[]);`,
      filename: "game.ts",
      errors: [
        {
          message:
            /given its type instead: View\.define<readonly Entity\[\]>\(name, \[\]\)\.$/u,
        },
      ],
    }),
});

new RuleTester().run("no-run-in-tests", plugin.rules["no-run-in-tests"], {
  valid: [
    {
      name: "a test that is an Effect yields what it runs",
      code: `it.effect("ticks", () => Effect.gen(function* () { const app = yield* App.make(Game); yield* app.tick(1); }));`,
    },
    {
      name: "a fiber started on a scheduler of its own",
      code: `const fiber = Effect.runFork(busy, { scheduler });`,
    },
  ],
  invalid: [
    "Effect.runSync(App.make(Game));",
    "await Effect.runPromise(App.make(Game));",
    "const exit = Effect.runSyncExit(Save.make(app));",
    "const exit = await Effect.runPromiseExit(load);",
    "Effect.runSyncWith(services)(app.read(World));",
    "Effect.gen(function* () {}).pipe(Effect.runSync);",
  ].map((code) => ({
    name: code,
    code,
    errors: [
      {
        message:
          /runs an Effect by hand\. A test is an Effect itself: write it with it\.effect/u,
      },
    ],
  })),
});

const arcadekit = (file: string) => `packages/arcadekit/src/${file}`;

new RuleTester().run("entry-imports", plugin.rules["entry-imports"], {
  valid: [
    {
      name: "arcadekit/browser imports its modules",
      filename: arcadekit("browser/index.ts"),
      code: `export * as Audio from "./Audio";\nexport * as Browser from "./Browser";`,
    },
    {
      name: "arcadekit/browser/Browser imports its folder and the browser platform",
      filename: arcadekit("browser/Browser.ts"),
      code: `import * as page from "./internal/page";\nimport * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";`,
    },
    {
      name: "a file of src/browser/ imports the game's modules, its folder and the browser platform",
      filename: arcadekit("browser/internal/audio.ts"),
      code: `import * as Sound from "../../Sound";\nimport { describe } from "./decode";\nimport * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";`,
    },
  ],
  invalid: [
    {
      name: "another entry imports arcadekit/browser/Browser",
      filename: arcadekit("Input.ts"),
      code: `import * as Browser from "./browser/Browser";`,
      errors: 1,
    },
    {
      name: "another entry imports a file of src/browser/",
      filename: arcadekit("Input.ts"),
      code: `import { listen } from "./browser/internal/devices";`,
      errors: 1,
    },
    {
      name: "a file of src/browser/ imports a package arcadekit/browser may not",
      filename: arcadekit("browser/internal/audio.ts"),
      code: `import * as THREE from "three";`,
      errors: 1,
    },
  ],
});

new RuleTester().run("no-page", plugin.rules["no-page"], {
  valid: [
    {
      name: "arcadekit/browser/Browser names what only a page has",
      filename: arcadekit("browser/Browser.ts"),
      code: "const base = document.baseURI;",
    },
    {
      name: "a file of src/browser/ names what only a page has",
      filename: arcadekit("browser/internal/devices.ts"),
      code: "const pads = navigator.getGamepads();",
    },
  ],
  invalid: [
    {
      name: "a file behind another entry names what only a page has",
      filename: arcadekit("Input.ts"),
      code: "const pads = navigator.getGamepads();",
      errors: 1,
    },
  ],
});

/**
 * A workspace on disk, as no-unused-internal reads one: `packages/kit`, and `packages/other`,
 * which imports it.
 */
const workspace = (files: Record<string, string>): string => {
  const cwd = mkdtempSync(join(tmpdir(), "no-unused-internal-"));
  const all: Record<string, string> = {
    "packages/kit/package.json": JSON.stringify({ name: "kit" }),
    "packages/other/package.json": JSON.stringify({ name: "other" }),
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  return cwd;
};

/** The case that lints `file` of a workspace of `files`. */
const linting = (
  name: string,
  files: Record<string, string>,
  file: string
): { name: string; cwd: string; filename: string; code: string } => {
  const cwd = workspace(files);
  return { name, cwd, filename: join(cwd, file), code: files[file]! };
};

const hidden = `/** @internal */
export interface Hidden {
  readonly n: number;
}

/** @internal */
export const helper = (n: number): number => n + 1;
`;

new RuleTester().run("no-unused-internal", plugin.rules["no-unused-internal"], {
  valid: [
    linting(
      "a module uses an @internal export in its code, not in its signatures",
      {
        "packages/kit/src/internal/impl.ts": hidden,
        "packages/kit/src/Mod.ts": `import type { Hidden } from "./internal/impl";
import * as impl from "./internal/impl";

/** Public. */
export const next = (n: number): number => {
  const kept: Hidden = { n: impl.helper(n) };
  return kept.n;
};
`,
      },
      "packages/kit/src/Mod.ts"
    ),
    linting(
      "an @internal export that a source uses",
      {
        "packages/kit/src/internal/impl.ts": hidden,
        "packages/kit/src/Mod.ts": `import { helper } from "./internal/impl";
import type { Hidden } from "./internal/impl";

/** Public. */
export const next = (n: number): number => helper(({ n } satisfies Hidden).n);
`,
      },
      "packages/kit/src/internal/impl.ts"
    ),
    linting(
      "a public signature names a public export of an internal file",
      {
        "packages/kit/src/internal/impl.ts": `/** Public. */
export interface Shown {
  readonly n: number;
}
`,
        "packages/kit/src/Mod.ts": `import type { Shown } from "./internal/impl";

/** Public. */
export const read = (shown: Shown): number => shown.n;
`,
      },
      "packages/kit/src/Mod.ts"
    ),
    linting(
      "an @internal member, and a private one, name an @internal export",
      {
        "packages/kit/src/internal/impl.ts": hidden,
        "packages/kit/src/Mod.ts": `import type { Hidden } from "./internal/impl";

/** Public. */
export interface Shown {
  /** @internal */
  readonly hidden: Hidden;
}

/** Public. */
export class Holder {
  private readonly kept: Hidden = { n: 0 };
  /** @internal */
  read(hidden: Hidden): number {
    return hidden.n + this.kept.n;
  }
}
`,
      },
      "packages/kit/src/Mod.ts"
    ),
    linting(
      "a public module exports all of a public module, @internal exports and all",
      {
        "packages/kit/src/Mod.ts": `/** Public. */\nexport const one = helper(0);\n\n/** @internal */\nexport const helper = (n: number): number => n + 1;\n`,
        "packages/kit/src/index.ts": `export * from "./Mod";\nexport * as Mod from "./Mod";\n`,
      },
      "packages/kit/src/index.ts"
    ),
    linting(
      "a file behind an entry, and no entry itself, declares an @internal export",
      {
        "packages/kit/package.json": JSON.stringify({
          name: "kit",
          exports: { ".": { source: "./src/index.ts" } },
        }),
        "packages/kit/src/core/table.ts": `/** Public. */\nexport const one = helper(0);\n\n/** @internal */\nexport const helper = (n: number): number => n + 1;\n`,
        "packages/kit/src/index.ts": `export { one } from "./core/table";\n`,
      },
      "packages/kit/src/core/table.ts"
    ),
  ],
  invalid: [
    ...[
      "export const read = (hidden: Hidden): number => hidden.n;",
      "export function read(hidden: Hidden): number {\n  return hidden.n;\n}",
      "export const read: (hidden: Hidden) => number = (hidden) => hidden.n;",
      "export const make = (): Hidden => ({ n: 0 });",
      "export type Of<A extends Hidden> = A;",
      "export interface Wrapped {\n  readonly hidden: Hidden;\n}",
      "export interface More extends Hidden {}",
      "export class Holder {\n  read(hidden: Hidden): number {\n    return hidden.n;\n  }\n}",
      "export class Holder {\n  readonly kept: Hidden = { n: 0 };\n}",
    ].map((declaration) => ({
      ...linting(
        `a public signature names an @internal export: ${declaration}`,
        {
          "packages/kit/src/internal/impl.ts": hidden,
          "packages/kit/src/Mod.ts": `import type { Hidden } from "./internal/impl";

/** Public. */
${declaration}
`,
        },
        "packages/kit/src/Mod.ts"
      ),
      errors: [
        {
          message: /^Hidden is @internal, but this public signature names it/u,
        },
      ],
    })),
    {
      ...linting(
        "a public signature names an @internal export through its namespace",
        {
          "packages/kit/src/internal/impl.ts": hidden,
          "packages/kit/src/Mod.ts": `import * as impl from "./internal/impl";

/** Public. */
export type Kept = impl.Hidden;
`,
        },
        "packages/kit/src/Mod.ts"
      ),
      errors: [
        {
          message: /^Hidden is @internal, but this public signature names it/u,
        },
      ],
    },
    {
      ...linting(
        "a public signature names an @internal export of another package",
        {
          "packages/kit/src/internal/impl.ts": hidden,
          "packages/kit/src/Mod.ts": `import type { Hidden } from "./internal/impl";

/** Public. */
export type Shown = Hidden;
`,
          "packages/other/src/index.ts": `import type { Hidden } from "kit/internal/impl";

/** Public. */
export type Kept = Hidden;
`,
        },
        "packages/other/src/index.ts"
      ),
      errors: [
        {
          message: /^Hidden is @internal, but this public signature names it/u,
        },
      ],
    },
    ...[
      `export { helper } from "./internal/impl";`,
      `import { helper } from "./internal/impl";\nexport { helper };`,
      `export { helper as next } from "./internal/impl";`,
    ].map((reexport) => ({
      ...linting(
        `a public module exports an @internal export again: ${reexport}`,
        {
          "packages/kit/src/internal/impl.ts": hidden,
          "packages/kit/src/index.ts": `${reexport}\nimport type { Hidden } from "./internal/impl";\nexport const n = ({ n: 0 } satisfies Hidden).n;\n`,
        },
        "packages/kit/src/index.ts"
      ),
      errors: [
        {
          message:
            /^helper is @internal, so a public module must not export it/u,
        },
      ],
    })),
    ...[
      `export * from "./internal/impl";`,
      `export * as Impl from "./internal/impl";`,
    ].map((reexport) => ({
      ...linting(
        `a public module exports all of a module with @internal exports: ${reexport}`,
        {
          "packages/kit/src/internal/impl.ts": hidden,
          "packages/kit/src/index.ts": `${reexport}\n`,
        },
        "packages/kit/src/index.ts"
      ),
      errors: [
        {
          message:
            /^src\/internal\/impl\.ts has @internal exports, so a public module must not export all of it/u,
        },
      ],
    })),
    {
      ...linting(
        "a public module exports an @internal export as its default",
        {
          "packages/kit/src/internal/impl.ts": hidden,
          "packages/kit/src/index.ts": `import { helper } from "./internal/impl";\nimport type { Hidden } from "./internal/impl";\nexport const n = ({ n: 0 } satisfies Hidden).n;\nexport default helper;\n`,
        },
        "packages/kit/src/index.ts"
      ),
      errors: [
        {
          message:
            /^helper is @internal, so a public module must not export it/u,
        },
      ],
    },
    {
      ...linting(
        "an entry's own file declares an @internal export",
        {
          "packages/kit/package.json": JSON.stringify({
            name: "kit",
            exports: { "./Mod": { source: "./src/Mod.ts" } },
          }),
          "packages/kit/src/Mod.ts": `/** Public. */\nexport const one = helper(0);\n\n/** @internal */\nexport const helper = (n: number): number => n + 1;\n`,
        },
        "packages/kit/src/Mod.ts"
      ),
      errors: [
        {
          message:
            /^helper is @internal, but src\/Mod\.ts is an entry, which a game imports/u,
        },
      ],
    },
    ...[
      "export interface Shown {\n  /** @internal */\n  readonly hidden: number;\n}",
      "export type Shown = {\n  /** @internal */\n  readonly hidden: number;\n};",
      "export class Shown {\n  /** @internal */\n  hidden(): number {\n    return 0;\n  }\n}",
    ].map((declaration) => ({
      ...linting(
        `a public export of an entry's own file has an @internal member: ${declaration}`,
        {
          "packages/kit/package.json": JSON.stringify({
            name: "kit",
            exports: { "./Mod": { source: "./src/Mod.ts" } },
          }),
          "packages/kit/src/Mod.ts": `/** Public. */\n${declaration}\n`,
        },
        "packages/kit/src/Mod.ts"
      ),
      errors: [
        {
          message:
            /^hidden is @internal, but it is a member of a public export of the entry src\/Mod\.ts/u,
        },
      ],
    })),
    {
      ...linting(
        "an @internal export that no source uses, though a test does",
        {
          "packages/kit/src/internal/impl.ts": `/** @internal */
export const unused = 1;
`,
          "packages/kit/test/Impl.test.ts": `import { unused } from "../src/internal/impl";\nunused;\n`,
        },
        "packages/kit/src/internal/impl.ts"
      ),
      errors: [
        {
          message:
            /^unused is @internal, and no source of the packages uses it/u,
        },
      ],
    },
  ],
});

/** A workspace whose package gives `src/Mod.ts` as `./Mod`, and `src/Part.ts` as `./Part`. */
const named = (name: string, files: Record<string, string>, file: string) =>
  linting(
    name,
    {
      "packages/kit/package.json": JSON.stringify({
        name: "kit",
        exports: {
          "./Mod": { source: "./src/Mod.ts" },
          "./Part": { source: "./src/Part.ts" },
        },
      }),
      ...files,
    },
    file
  );

new RuleTester().run("names", plugin.rules.names, {
  valid: [
    named(
      "a module's main type is its name, and its other types are named for what they are",
      {
        "packages/kit/src/Mod.ts": `export interface Mod {}\nexport interface Reader {}\nexport type Mods = readonly Mod[];\nexport class Modded {}\n`,
      },
      "packages/kit/src/Mod.ts"
    ),
    named(
      "an error's tag is its module's name and its class's together",
      {
        "packages/kit/src/Mod.ts": `import { Data, Schema } from "effect";\nexport class Refused extends Data.TaggedError("ModRefused")<{}> {}\nexport class Unknown extends Schema.TaggedError<Unknown>()("ModUnknown", {}) {}\n`,
      },
      "packages/kit/src/Mod.ts"
    ),
    named(
      "a part's names are read after the module that gives them again",
      {
        "packages/kit/src/Part.ts": `export interface PartShape {}\n`,
        "packages/kit/src/Mod.ts": `export type { PartShape } from "./Part.ts";\n`,
      },
      "packages/kit/src/Part.ts"
    ),
    named(
      "a file that is no entry names its types as it likes",
      { "packages/kit/src/internal/mod.ts": `export interface ModThing {}\n` },
      "packages/kit/src/internal/mod.ts"
    ),
  ],
  invalid: [
    ...[
      "export interface ModReader {}",
      "export type AnyMod = unknown;",
      "export class InvalidMod {}",
    ].map((declaration) => ({
      ...named(
        `a type repeats its module's name: ${declaration}`,
        { "packages/kit/src/Mod.ts": `${declaration}\n` },
        "packages/kit/src/Mod.ts"
      ),
      errors: [
        { message: /repeats Mod, the namespace a game reads it after/u },
      ],
    })),
    {
      ...named(
        "a part's name repeats the module that gives it again",
        {
          "packages/kit/src/Part.ts": `export interface ModShape {}\n`,
          "packages/kit/src/Mod.ts": `export type { ModShape } from "./Part.ts";\n`,
        },
        "packages/kit/src/Part.ts"
      ),
      errors: [{ message: /^ModShape repeats Mod/u }],
    },
    ...[
      `export class Refused extends Data.TaggedError("Refused")<{}> {}`,
      `export class Refused extends Schema.TaggedError<Refused>()("PartRefused", {}) {}`,
    ].map((declaration) => ({
      ...named(
        `an error's tag is not its module's name and its class's: ${declaration}`,
        {
          "packages/kit/src/Mod.ts": `import { Data, Schema } from "effect";\n${declaration}\n`,
        },
        "packages/kit/src/Mod.ts"
      ),
      errors: [
        {
          message:
            /^Refused's tag is "\w+"\. An error's tag is its namespace and its class together, "ModRefused"/u,
        },
      ],
    })),
  ],
});

new RuleTester().run("no-empty-payload", plugin.rules["no-empty-payload"], {
  valid: [
    {
      name: "an action and an event with no payload give no schema",
      code: `const Pass = Action.define("duel/Pass");\nconst Started = Event.define("game/Started");`,
    },
    {
      name: "an action with no payload and an error gives Schema.Void",
      code: `const Pass = Action.define("duel/Pass", Schema.Void, { error: Tired });`,
    },
    {
      name: "a payload with fields",
      code: `const Move = Action.define("duel/Move", Schema.Struct({ dx: Schema.Number }));\nconst Hit = Event.define("duel/Hit", Schema.Struct({ by: Schema.String }));`,
    },
    {
      name: "an empty struct that is no action's or event's payload",
      code: `const Nothing = Schema.Struct({});\nconst Tag = Singleton.define("duel/Tag", Schema.Struct({}));`,
    },
  ],
  invalid: [
    {
      name: "an action with no payload gives an empty struct",
      code: `const Pass = Action.define("duel/Pass", Schema.Struct({}));`,
      errors: [
        {
          message:
            /^Schema\.Struct\(\{\}\) is a payload with nothing in it, which every call must still give as \{\}\. Give no schema: Action\.define\("duel\/Pass"\), dispatched as app\.dispatch\(Pass\)\.$/u,
        },
      ],
    },
    {
      name: "an event with no payload gives an empty struct",
      code: `const Started = Event.define("game/Started", Schema.Struct({}));`,
      errors: [
        {
          message:
            /Give no schema: Event\.define\("game\/Started"\), emitted as emit\(\)\.$/u,
        },
      ],
    },
    {
      name: "an action with an error gives an empty struct",
      code: `const Pass = Action.define("duel/Pass", Schema.Struct({}), { error: Tired });`,
      errors: [
        {
          message:
            /An action with an error and no payload takes Schema\.Void: Action\.define\("duel\/Pass", Schema\.Void, \{ error \}\), dispatched as app\.dispatch\(Pass\)\.$/u,
        },
      ],
    },
  ],
});
