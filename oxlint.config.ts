import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  env: core.env,
  extends: [core, vitest],
  ignorePatterns: core.ignorePatterns,
  rules: {
    // Hot loops read typed arrays under `noUncheckedIndexedAccess`; `!` is the
    // zero-cost way to say "index is in range" without a branch per read.
    "typescript/no-non-null-assertion": "off",
    // Seeded RNG and spatial hashing need integer bit math.
    "eslint/no-bitwise": "off",
    // Effect Schema convention: `const X = Schema.Struct(...)` + `type X = typeof X.Type`.
    "eslint/no-redeclare": "off",
    // Key order carries meaning (schema fields, lifecycle phases, event payloads).
    "eslint/sort-keys": "off",
    // Files read top-down: the entry point first, helpers below.
    "eslint/no-use-before-define": "off",
    // `for (let i = 0; i < n; i++)` is the idiom in pool and simulation loops.
    "eslint/no-plusplus": ["error", { allowForLoopAfterthoughts: true }],
    // `Effect.gen(function* () { ... })` is the Effect idiom.
    "eslint/func-names": "off",
    // Effect and Foldkit APIs take callbacks by design.
    "promise/prefer-await-to-callbacks": "off",
  },
  overrides: [
    {
      files: ["**/*.test.ts"],
      rules: {
        // `toBe(true)` is stricter than `toBeTruthy()`.
        "vitest/prefer-to-be-truthy": "off",
        "vitest/prefer-to-be-falsy": "off",
      },
    },
  ],
});
