import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

// Every Math function ECMA-262 lets each engine approximate. A genre's step must give the same
// bits in every engine (ADR-0011), so its simulation calls none of them.
const APPROXIMATED_MATH = [
  "acos",
  "acosh",
  "asin",
  "asinh",
  "atan",
  "atanh",
  "atan2",
  "cbrt",
  "cos",
  "cosh",
  "exp",
  "expm1",
  "hypot",
  "log",
  "log1p",
  "log10",
  "log2",
  "pow",
  "sin",
  "sinh",
  "tan",
  "tanh",
] as const;

const approximatedMathMessage =
  "is approximated differently by each engine, so a step that calls it can desync lockstep peers. Use exact operations, such as survivors' math.ts (hypot2, sin, cos, powInt). See docs/adr/0011-a-step-uses-only-exact-math.md.";

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
    // Assumes every `.push()` is Array#push; its autofix merges calls to
    // `EventBuffer.push`, which takes one event, and silently drops events.
    "unicorn/prefer-single-call": "off",
    // Switches over unions are checked for exhaustiveness by TypeScript; a
    // `default` branch would hide a missing case.
    "eslint/default-case": "off",
    // `Effect.gen(function* () { ... })` is the Effect idiom.
    "eslint/func-names": "off",
    // Effect and Foldkit APIs take callbacks by design.
    "promise/prefer-await-to-callbacks": "off",
  },
  overrides: [
    {
      // Genre simulation code: root entries, not the views in ./browser, not tests.
      files: [
        "packages/survivors/src/**/*.ts",
        "packages/push-puzzle/src/**/*.ts",
      ],
      excludeFiles: ["**/browser/**", "**/*.test.ts"],
      jsPlugins: ["./lint/deterministic-math.ts"],
      rules: {
        "eslint/no-restricted-properties": [
          "error",
          ...APPROXIMATED_MATH.map((property) => ({
            object: "Math",
            property,
            message: `Math.${property} ${approximatedMathMessage}`,
          })),
        ],
        "deterministic-math/no-exponentiation": "error",
      },
    },
    {
      files: ["**/*.test.ts"],
      plugins: ["vitest"],
      rules: {
        // `toBe(true)` is stricter than `toBeTruthy()`.
        "vitest/prefer-to-be-truthy": "off",
        "vitest/prefer-to-be-falsy": "off",
      },
    },
  ],
});
