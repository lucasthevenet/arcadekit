import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import plugin from "./plugin.ts";

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({
  languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } },
});

const arcadekit = (file: string): string => `packages/arcadekit/src/${file}`;
const three = (file: string): string => `packages/three/src/${file}`;

tester.run("entry-imports", plugin.rules["entry-imports"], {
  valid: [
    // The storage core: itself alone.
    {
      filename: arcadekit("ecs/world.ts"),
      code: `import { x } from "./component";`,
    },
    // Every other entry: Effect, the storage core, and one another.
    {
      filename: arcadekit("App.ts"),
      code: `import { Effect } from "effect";\nimport { Pipeable } from "effect/Pipeable";\nimport { World } from "./ecs/world";\nimport type { Time } from "./Services";\nexport * from "./System";`,
    },
    {
      filename: arcadekit("index.ts"),
      code: `export * as Input from "./Input";\nexport { World as EcsWorld } from "./ecs/index";`,
    },
    // The page's entry: a browser package, and the rest of the kit.
    {
      filename: arcadekit("Browser.ts"),
      code: `import { runMain } from "@effect/platform-browser/BrowserRuntime";\nimport { Effect } from "effect";\nimport * as App from "./App";\nimport { World } from "./ecs/world";`,
    },
    {
      filename: three("Gltf.ts"),
      code: `import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";\nimport * as THREE from "three";\nimport { Assets } from "arcadekit/Assets";\nimport { Effect } from "effect";\nimport * as Three from "./Three";`,
    },
    // Not a source of a published package.
    {
      filename: "packages/arcadekit/test/app.test.ts",
      code: `import "vitest";`,
    },
  ],
  invalid: [
    {
      filename: arcadekit("ecs/world.ts"),
      code: `import { Effect } from "effect";`,
      errors: [
        {
          message:
            /src\/ecs\/world\.ts must not import "effect": arcadekit\/ecs is the storage core alone/u,
        },
      ],
    },
    {
      filename: arcadekit("ecs/world.ts"),
      code: `import type { Time } from "../Services";`,
      errors: [
        { message: /must not import \.\.\/Services \(src\/Services\)/u },
      ],
    },
    {
      filename: arcadekit("ecs/world.ts"),
      code: `export { x } from "../ecs-helpers/x";`,
      errors: 1,
    },
    {
      filename: arcadekit("App.ts"),
      code: `import { runMain } from "@effect/platform-browser/BrowserRuntime";`,
      errors: [
        {
          message:
            /src\/App\.ts must not import "@effect\/platform-browser\/BrowserRuntime": every entry of arcadekit but arcadekit\/Browser imports Effect and nothing else/u,
        },
      ],
    },
    {
      filename: arcadekit("App.ts"),
      code: `import type { Keyboard } from "./Browser";`,
      errors: [{ message: /must not import \.\/Browser \(src\/Browser\)/u }],
    },
    {
      filename: arcadekit("ecs/world.ts"),
      code: `export * from "../Browser";`,
      errors: 1,
    },
    {
      filename: arcadekit("Input.ts"),
      code: `export * from "lodash";\nconst load = () => import("three");`,
      errors: 2,
    },
    {
      filename: arcadekit("Browser.ts"),
      code: `import * as THREE from "three";`,
      errors: [
        {
          message:
            /arcadekit\/Browser imports Effect, and may import @effect\/platform-browser/u,
        },
      ],
    },
    {
      filename: three("Three.ts"),
      code: `import { Keyboard } from "@effect/platform-browser";`,
      errors: [
        {
          message:
            /@arcadekit\/three imports arcadekit, Effect and Three\.js, its peers, and nothing else/u,
        },
      ],
    },
  ],
});

tester.run("no-page", plugin.rules["no-page"], {
  valid: [
    {
      filename: arcadekit("Browser.ts"),
      code: `const frame = requestAnimationFrame;\nwindow.addEventListener("keydown", () => {});\nconst audio = new AudioContext();`,
    },
    {
      filename: three("Three.ts"),
      code: `const canvas = document.createElement("canvas");`,
    },
    // A word in a comment or a string names nothing.
    {
      filename: arcadekit("App.ts"),
      code: `// Browser.ts runs it on requestAnimationFrame.\nconst why = "a document of the save";`,
    },
  ],
  invalid: [
    {
      filename: arcadekit("App.ts"),
      code: `const frame = requestAnimationFrame;`,
      errors: [
        {
          message:
            /src\/App\.ts must not name requestAnimationFrame, which only a page has/u,
        },
      ],
    },
    {
      filename: arcadekit("Input.ts"),
      code: `const listen = (target: EventTarget) => target.addEventListener("keydown", () => {});`,
      errors: 1,
    },
    {
      filename: arcadekit("ecs/world.ts"),
      code: `const { navigator } = globalThis;\nconst page = globalThis.window;\nlet document: unknown;`,
      errors: 3,
    },
    {
      filename: arcadekit("Sound.ts"),
      code: `const make = () => new OfflineAudioContext(1, 1, 1);\nconst pictures = createImageBitmap;\ncancelAnimationFrame(0);\ntype Context = AudioContext;`,
      errors: 4,
    },
  ],
});

tester.run("no-code-from-text", plugin.rules["no-code-from-text"], {
  valid: [
    {
      filename: arcadekit("Query.ts"),
      code: `const read = (row: number) => () => row;\nconst evaluate = (x: number) => x;`,
    },
  ],
  invalid: [
    {
      filename: arcadekit("Query.ts"),
      code: `eval("1");`,
      errors: [{ message: /^eval makes code from text/u }],
    },
    {
      filename: arcadekit("Query.ts"),
      code: `globalThis.eval("1");`,
      errors: 1,
    },
    {
      filename: arcadekit("Query.ts"),
      code: `new Function("return 1");`,
      errors: [{ message: /^new Function makes code from text/u }],
    },
    {
      filename: arcadekit("Query.ts"),
      code: `Function("return 1")();`,
      errors: 1,
    },
    {
      filename: arcadekit("Query.ts"),
      code: `const AsyncFunction = (async () => {}).constructor;\nnew AsyncFunction("await 1");`,
      errors: 1,
    },
    {
      filename: arcadekit("ecs/world.ts"),
      code: `new GeneratorFunction("yield 1");\nnew AsyncGeneratorFunction("yield 1");`,
      errors: 2,
    },
    {
      filename: three("Three.ts"),
      code: `const made = Function(source);`,
      errors: 1,
    },
  ],
});
