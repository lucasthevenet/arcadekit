import { readFileSync } from "node:fs";

import { defineConfig } from "oxlint";
import type { DummyRuleMap } from "oxlint";
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

// The simulation reads no clock or random source of its own: its time comes in as an argument
// and its randomness from the run's seeded Rng, so every peer and every replay computes the same
// step (ADR-0017).
const ownTimeOrRandomness =
  "The simulation reads no clock or random source of its own: take the time as an argument and draw from the run's seeded Rng, so every peer and replay computes the same step. See docs/adr/0017-effect-at-the-edges-plain-code-inside.md.";

// The globals that read the time or a random source.
const CLOCK_AND_RANDOM_GLOBALS = [
  "Date",
  "Temporal",
  "performance",
  "crypto",
] as const;

const noOwnTimeOrRandomness: DummyRuleMap = {
  "eslint/no-restricted-globals": [
    "error",
    ...CLOCK_AND_RANDOM_GLOBALS.map((name) => ({
      name,
      message: ownTimeOrRandomness,
    })),
  ],
  "eslint/no-restricted-imports": [
    "error",
    {
      paths: [
        {
          name: "effect",
          importNames: ["Clock", "Random", "DateTime"],
          message: ownTimeOrRandomness,
        },
        { name: "effect/Clock", message: ownTimeOrRandomness },
        { name: "effect/Random", message: ownTimeOrRandomness },
        { name: "effect/DateTime", message: ownTimeOrRandomness },
      ],
    },
  ],
};

// Math.random, and those globals reached through globalThis, window or self, which
// no-restricted-globals doesn't see.
const ownTimeOrRandomnessProperties = [
  {
    object: "Math",
    property: "random",
    message: `Math.random: ${ownTimeOrRandomness}`,
  },
  ...["globalThis", "window", "self"].flatMap((object) =>
    CLOCK_AND_RANDOM_GLOBALS.map((property) => ({
      object,
      property,
      message: `${object}.${property}: ${ownTimeOrRandomness}`,
    }))
  ),
];

// Which entry of the arcadekit package may import which (ADR-0018). This is the graph the nine
// packages had when they were separate: core and input stand alone, runtime steps with core's
// clock, net steps a GameLoop and seeds its test network with core's Rng, and foldkit's tests
// drive a real engine from runtime (its own code only names the engine's shape). Adding an
// arrow here is a design decision: say why in the PR.
const KIT_SRC = "packages/arcadekit/src";
const ENTRY_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  core: [],
  input: [],
  content: [],
  save: [],
  audio: [],
  "render-three": [],
  runtime: ["core"],
  net: ["core", "runtime"],
  foldkit: ["runtime"],
};

// Each entry's public file: the `source` of each of the package's exports, from src/, without
// its extension. An import from another entry must name one of them.
const kitExports = (
  JSON.parse(readFileSync("packages/arcadekit/package.json", "utf-8")) as {
    readonly exports: Readonly<Record<string, { readonly source: string }>>;
  }
).exports;
const ENTRY_FILES = Object.values(kitExports).map(({ source }) =>
  source.replace(/^\.\/src\//u, "").replace(/\.ts$/u, "")
);

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
          ...ownTimeOrRandomnessProperties,
        ],
        "deterministic-math/no-exponentiation": "error",
        ...noOwnTimeOrRandomness,
      },
    },
    {
      // The rest of the simulation: core's primitives, the loop that steps a genre, and the
      // lockstep protocol that steps it on every peer, with the input codecs whose decoded
      // value every peer steps on and the step input built from the players' inputs (ADR-0017).
      files: [
        "packages/arcadekit/src/core/**/*.ts",
        "packages/arcadekit/src/runtime/loop.ts",
        "packages/arcadekit/src/runtime/simulation.ts",
        "packages/arcadekit/src/runtime/player-inputs.ts",
        "packages/arcadekit/src/net/lockstep.ts",
        "packages/arcadekit/src/net/codec.ts",
        "packages/arcadekit/src/net/player-inputs.ts",
      ],
      excludeFiles: ["**/*.test.ts"],
      rules: {
        "eslint/no-restricted-properties": [
          "error",
          ...ownTimeOrRandomnessProperties,
        ],
        ...noOwnTimeOrRandomness,
      },
    },
    {
      // Core and input don't depend on Effect, so a game can use them without it (ADR-0017).
      // When several overrides set a rule, the last one's options replace the others', so core
      // gets this import rule instead of the one above. It bans all of `effect`, so it covers it.
      files: [
        "packages/arcadekit/src/core/**/*.ts",
        "packages/arcadekit/src/input/**/*.ts",
      ],
      excludeFiles: ["**/*.test.ts"],
      rules: {
        "eslint/no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["effect", "effect/**", "@effect/**"],
                message:
                  "arcadekit/core and arcadekit/input don't depend on Effect, so a game can use them without it. See docs/adr/0017-effect-at-the-edges-plain-code-inside.md.",
              },
            ],
          },
        ],
      },
    },
    {
      // The entries of the one package keep the direction the nine packages had (ADR-0018).
      files: ["packages/arcadekit/src/**/*.ts"],
      jsPlugins: ["./lint/entry-direction.ts"],
      rules: {
        "entry-direction/allowed": [
          "error",
          {
            packageName: "arcadekit",
            root: KIT_SRC,
            allowed: ENTRY_IMPORTS,
            entryFiles: ENTRY_FILES,
          },
        ],
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
