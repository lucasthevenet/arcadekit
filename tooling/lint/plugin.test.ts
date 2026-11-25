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
  ].map((cast) => ({
    name: cast,
    code: `const id = ${cast};`,
    filename: "game.ts",
    errors: [{ message: /^This asserts that a value is an entity's id/u }],
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
 * A workspace on disk, as no-internal-in-entries reads one: `packages/kit`, whose entries are
 * `kit` (src/index.ts) and `kit/Mod` (src/Mod.ts), and `packages/other`, which imports it.
 */
const workspace = (files: Record<string, string>): string => {
  const cwd = mkdtempSync(join(tmpdir(), "no-internal-in-entries-"));
  const all: Record<string, string> = {
    "packages/kit/package.json": JSON.stringify({
      name: "kit",
      exports: {
        ".": { source: "./src/index.ts", default: "./dist/index.js" },
        "./Mod": { source: "./src/Mod.ts", default: "./dist/Mod.js" },
      },
    }),
    "packages/other/package.json": JSON.stringify({
      name: "other",
      exports: { ".": { source: "./src/index.ts" } },
    }),
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

new RuleTester().run(
  "no-internal-in-entries",
  plugin.rules["no-internal-in-entries"],
  {
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
        "a public module exports all of a public module",
        {
          "packages/kit/src/Mod.ts": `/** Public. */\nexport const one = 1;\n`,
          "packages/kit/src/index.ts": `export * from "./Mod";\nexport * as Mod from "./Mod";\n`,
        },
        "packages/kit/src/index.ts"
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
            message:
              /^Hidden is @internal, but this public signature names it/u,
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
            message:
              /^Hidden is @internal, but this public signature names it/u,
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
            message:
              /^Hidden is @internal, but this public signature names it/u,
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
      {
        ...linting(
          "an entry declares an @internal export",
          {
            "packages/kit/src/internal/impl.ts": `import { helper } from "../Mod";\n\n/** Public. */\nexport const two = helper(1);\n`,
            "packages/kit/src/Mod.ts": `/**
 * The next number.
 *
 * @internal
 */
export const helper = (n: number): number => n + 1;
`,
          },
          "packages/kit/src/Mod.ts"
        ),
        errors: [
          { message: /^helper is @internal, but src\/Mod\.ts is an entry/u },
        ],
      },
    ],
  }
);
