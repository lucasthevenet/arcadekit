import { readFileSync } from "node:fs";

import { defineConfig } from "oxlint";
import type { DummyRuleMap } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

// Every Math function ECMA-262 lets each engine approximate. A genre's step must give the same
// bits in every engine, so its simulation calls none of them, and neither does
// arcadekit/core, whose functions a step calls.
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
  "is approximated differently by each engine, so a step that calls it can desync lockstep peers. Use exact operations, such as arcadekit/core's ExactMath (hypot2, sin, cos, powInt). See .agents/skills/simulation/SKILL.md.";

const approximatedMathProperties = APPROXIMATED_MATH.map((property) => ({
  object: "Math",
  property,
  message: `Math.${property} ${approximatedMathMessage}`,
}));

// The simulation reads no clock or random source of its own: its time comes in as an argument
// and its randomness from the run's seeded Rng, so every peer and every replay computes the same
// step.
const ownTimeOrRandomness =
  "The simulation reads no clock or random source of its own: take the time as an argument and draw from the run's seeded Rng, so every peer and replay computes the same step. See .agents/skills/simulation/SKILL.md.";

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

// Library code runs no Effect of its own: it returns the Effect, and the app's runtime runs it.
// The `...With` forms are left alone: they are how plain code a host calls runs an
// Effect on a context captured once.
const EFFECT_RUNNERS = [
  "runSync",
  "runSyncExit",
  "runPromise",
  "runPromiseExit",
  "runFork",
  "runCallback",
] as const;

const ownRunner =
  'Library code runs no Effect itself: return the Effect, and the app\'s runtime runs it. Plain code that a host calls captures a runner once (FiberHandle.runtime, or Effect.context with Effect.runForkWith). See "Where plain code and Effect meet" in .agents/skills/effect-or-plain/SKILL.md.';

const ownRunnerProperties = [
  ...EFFECT_RUNNERS.map((property) => ({
    object: "Effect",
    property,
    message: `Effect.${property}: ${ownRunner}`,
  })),
  // A runtime of its own is the other way to run one.
  {
    object: "ManagedRuntime",
    property: "make",
    message: `ManagedRuntime.make: ${ownRunner}`,
  },
];

// What a test imports, in the folders of library code: the kit's testing entries, whose helpers
// may run an Effect to build a fixture. The tests and the helpers only they import are in each
// package's test/, outside library code.
const TEST_HELPERS = ["**/testing/**"];

const KIT_SRC = "packages/arcadekit/src";

// Each entry's public file: the `source` of each of the package's exports, from src/, without
// its extension.
const kitExports = (
  JSON.parse(readFileSync("packages/arcadekit/package.json", "utf-8")) as {
    readonly exports: Readonly<Record<string, { readonly source: string }>>;
  }
).exports;
const ENTRY_FILES = Object.values(kitExports).map(({ source }) =>
  source.replace(/^\.\/src\//u, "").replace(/\.ts$/u, "")
);

// The genre packages' public files, from each one's `exports`: a genre's public file is a barrel
// of namespaces too (.agents/skills/game-modules/SKILL.md).
const GENRES = ["push-puzzle", "survivors"] as const;
const GENRE_ENTRY_FILES = GENRES.flatMap((genre) =>
  Object.values(
    (
      JSON.parse(readFileSync(`packages/${genre}/package.json`, "utf-8")) as {
        readonly exports: Readonly<Record<string, string>>;
      }
    ).exports
  ).map((source) => `packages/${genre}/${source.replace(/^\.\//u, "")}`)
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
    // A `match` case that drops an event says so: `HeroLeft: () => undefined`. An empty body
    // would be a type error, since a case returns a Message or `undefined`. `checkArguments`
    // stays off, as ultracite has it: an explicit `undefined` argument is a choice.
    "unicorn/no-useless-undefined": [
      "error",
      { checkArguments: false, checkArrowFunctionBody: false },
    ],
    // A declaration is a class (`class LevelSolved extends Game.Event(...) {}`), and one file
    // declares what belongs together: a game's events, or a command with what it reports.
    "eslint/max-classes-per-file": "off",
    // A doc comment is written as Effect's are, and ends in `@category` and `@since`
    // (.agents/skills/doc-comments/SKILL.md). `@since` is a standard tag; `@category` is Effect's.
    "jsdoc/check-tag-names": ["error", { definedTags: ["category"] }],
  },
  overrides: [
    {
      // Where the kit and the genres refuse a mistake. A refusal throws `Error`, or `RangeError`
      // for a number out of range, never `TypeError` (.agents/skills/declarations/SKILL.md, "Refusing a mistake").
      // This rule makes the throw after a `typeof` test a `TypeError`, so the two halves of one
      // check threw two classes.
      files: ["packages/*/src/**/*.ts"],
      rules: { "unicorn/prefer-type-error": "off" },
    },
    {
      // Library code, but for what a test imports and the one file whose entry points
      // Cloudflare owns. The three overrides below set the same rule for the simulation's files,
      // and the last one's options replace the others', so they repeat this list.
      files: ["packages/*/src/**/*.ts"],
      excludeFiles: [
        ...TEST_HELPERS,
        "packages/arcadekit/src/net/worker/signalling-worker.ts",
      ],
      rules: {
        "eslint/no-restricted-properties": ["error", ...ownRunnerProperties],
      },
    },
    {
      // Genre simulation code: the root entry of every package but the kit, so a new genre is
      // held to it from its first file. Not the views in ./browser, not tests or their helpers.
      files: ["packages/*/src/**/*.ts"],
      excludeFiles: ["packages/arcadekit/**", "**/browser/**", ...TEST_HELPERS],
      jsPlugins: ["./tools/lint/deterministic-math.ts"],
      rules: {
        "eslint/no-restricted-properties": [
          "error",
          ...approximatedMathProperties,
          ...ownTimeOrRandomnessProperties,
          ...ownRunnerProperties,
        ],
        "deterministic-math/no-exponentiation": "error",
        ...noOwnTimeOrRandomness,
      },
    },
    {
      // The rest of the simulation: core's primitives, the loop that steps a genre, and the
      // lockstep protocol that steps it on every peer, with the input codecs whose decoded
      // value every peer steps on and the step input built from the players' inputs.
      // The test game too: its simulation is the one a Co-op game's tests copy. All of
      // arcadekit/game, the kernel under `Game.Loop` included (internal/kernel.ts), so a new file
      // of it is held to this from the start. Two of its files are left out by name, since they
      // are where a browser's time and randomness come in: the engine is the Effect host, and
      // draws a run's seed from Effect's `Random`; frames.ts is the engine's frame clock, and
      // reads `performance.now()` to give a frame's time to whoever steps.
      files: [
        "packages/arcadekit/src/core/**/*.ts",
        "packages/arcadekit/src/game/**/*.ts",
        "packages/arcadekit/src/net/lockstep-session.ts",
        "packages/arcadekit/src/net/internal/codec.ts",
        "packages/arcadekit/src/net/internal/player-inputs.ts",
        "packages/arcadekit/src/net/testing/test-game.ts",
      ],
      excludeFiles: [
        "packages/arcadekit/src/game/engine.ts",
        "packages/arcadekit/src/game/frames.ts",
      ],
      rules: {
        "eslint/no-restricted-properties": [
          "error",
          ...ownTimeOrRandomnessProperties,
          ...ownRunnerProperties,
        ],
        ...noOwnTimeOrRandomness,
      },
    },
    {
      // Core holds the exact math a step calls (core/exact-math.ts), and its timers, eases
      // and Rng are a step's too. So core is held to exact math as a genre's root entry is: no
      // approximated `Math` function and no `**`. It comes after the override above, whose
      // options for this rule it replaces, so it repeats that list. Not its tests, in test/core:
      // they compare the replacements with the engine's `Math`.
      files: ["packages/arcadekit/src/core/**/*.ts"],
      jsPlugins: ["./tools/lint/deterministic-math.ts"],
      rules: {
        "eslint/no-restricted-properties": [
          "error",
          ...approximatedMathProperties,
          ...ownTimeOrRandomnessProperties,
          ...ownRunnerProperties,
        ],
        "deterministic-math/no-exponentiation": "error",
      },
    },
    {
      // An entry's public file in Effect's shape is a barrel of namespaces (`export * as Ring from
      // "./ring"`), as Effect's own index is (.agents/skills/kit-modules/SKILL.md), and its
      // modules import `effect`, so what it loads is counted in the hundreds. What a game imports
      // of it is what a bundler keeps. A genre's public file is one too.
      files: [
        ...ENTRY_FILES.map((file) => `${KIT_SRC}/${file}.ts`),
        ...GENRE_ENTRY_FILES,
      ],
      rules: { "oxc/no-barrel-file": "off" },
    },
    {
      files: ["**/*.test.ts"],
      plugins: ["vitest"],
      rules: {
        // `toBe(true)` is stricter than `toBeTruthy()`.
        "vitest/prefer-to-be-truthy": "off",
        "vitest/prefer-to-be-falsy": "off",
        // A scenario asserts: it throws at the first expectation that doesn't hold
        // (`arcadekit/game/scenario`).
        "vitest/expect-expect": [
          "error",
          { assertFunctionNames: ["expect", "expectTypeOf", "scenario"] },
        ],
      },
    },
  ],
});
