import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

// The Vitest preset is one override, for the test files. It is taken in here
// rather than extended, since a later override cannot change the options of
// a rule an earlier one set.
const [tests] = vitest.overrides ?? [];

// Ultracite's core and Vitest presets; anti-slop and its Effect rules, vendored
// in tooling/oxlint/anti-slop; and arcadekit's own rules,
// tooling/oxlint/arcadekit, on the sources of the published packages.
export default defineConfig({
  env: core.env,
  extends: [core],
  ignorePatterns: [
    ...core.ignorePatterns,
    ".agents/**",
    ".claude/**",
    "tooling/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tooling/oxlint/anti-slop/index.ts" },
    {
      name: "anti-slop-effect",
      specifier: "./tooling/oxlint/anti-slop/effect/index.ts",
    },
    { name: "arcadekit", specifier: "./tooling/oxlint/arcadekit/index.ts" },
  ],
  rules: {
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
    // Rules of Ultracite's core that anti-slop contradicts: the first two
    // rewrite what no-known-value-widening flags, and the third asks for the
    // Reflect.apply that no-reflect-apply refuses.
    "typescript/consistent-indexed-object-style": "off",
    "unicorn/no-immediate-mutation": "off",
    "unicorn/prefer-reflect-apply": "off",
    // Off for now, to be turned back on once the rest is fixed: key order
    // carries meaning (schema fields, config sections); Effect.gen takes an
    // unnamed function*; Effect's APIs take callbacks; TypeScript checks a
    // switch over a union is exhaustive, and a default would hide a missing
    // case; Schema names a value and its type alike.
    "eslint/sort-keys": "off",
    "eslint/func-names": "off",
    "promise/prefer-await-to-callbacks": "off",
    "eslint/default-case": "off",
    "eslint/no-redeclare": "off",
    // TypeDoc's tag, which sorts the reference into sections.
    "jsdoc/check-tag-names": ["error", { definedTags: ["category"] }],
    // A system or a handler is a generator even when it needs no service,
    // so it may have no `yield`.
    "eslint/require-yield": "off",
    // What the storage core is written with on purpose: indexed reads that
    // are in range by construction, and an id's bits.
    "typescript/no-non-null-assertion": "off",
    "eslint/no-bitwise": "off",
  },
  overrides: [
    {
      ...tests,
      rules: {
        ...tests?.rules,
        // Vitest's expect takes a message as its second argument.
        "vitest/valid-expect": ["error", { maxArgs: 2 }],
        // A test says what a value is, not only that it is truthy, and checks
        // as much as it needs to.
        "vitest/prefer-to-be-truthy": "off",
        "vitest/prefer-to-be-falsy": "off",
        "vitest/max-expects": "off",
      },
    },
    {
      // A module at the top of a package's src is one of its entries, named
      // as it is imported: arcadekit/Query, @arcadekit/three/Gltf.
      files: ["packages/*/src/*.ts"],
      rules: {
        "unicorn/filename-case": [
          "error",
          { case: "pascalCase", ignore: [String.raw`^index\.ts$`] },
        ],
      },
    },
    {
      files: ["packages/*/src/**"],
      rules: {
        "arcadekit/entry-imports": "error",
        "arcadekit/no-page": "error",
        "arcadekit/no-code-from-text": "error",
      },
    },
  ],
});
