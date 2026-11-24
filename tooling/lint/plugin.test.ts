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
      name: "arcadekit/Browser imports its folder and the browser platform",
      filename: arcadekit("Browser.ts"),
      code: `import { listen } from "./browser/internal/devices";\nimport * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";`,
    },
    {
      name: "a file of src/browser/ imports the game's modules, its folder and the browser platform",
      filename: arcadekit("browser/internal/audio.ts"),
      code: `import * as Sound from "../../Sound";\nimport { describe } from "./media";\nimport * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";`,
    },
  ],
  invalid: [
    {
      name: "another entry imports src/Browser.ts",
      filename: arcadekit("Input.ts"),
      code: `import * as Browser from "./Browser";`,
      errors: 1,
    },
    {
      name: "another entry imports a file of src/browser/",
      filename: arcadekit("Input.ts"),
      code: `import { listen } from "./browser/internal/devices";`,
      errors: 1,
    },
    {
      name: "a file of src/browser/ imports a package arcadekit/Browser may not",
      filename: arcadekit("browser/internal/audio.ts"),
      code: `import * as THREE from "three";`,
      errors: 1,
    },
  ],
});

new RuleTester().run("no-page", plugin.rules["no-page"], {
  valid: [
    {
      name: "src/Browser.ts names what only a page has",
      filename: arcadekit("Browser.ts"),
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
