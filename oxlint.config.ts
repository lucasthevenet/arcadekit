import { readFileSync } from "node:fs";

import { defineConfig } from "oxlint";
import type { DummyRuleMap } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

// Every Math function ECMA-262 lets each engine approximate. A genre's step must give the same
// bits in every engine (ADR-0011), so its simulation calls none of them, and neither does
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
  "is approximated differently by each engine, so a step that calls it can desync lockstep peers. Use exact operations, such as arcadekit/core's ExactMath (hypot2, sin, cos, powInt). See docs/adr/0011-a-step-uses-only-exact-math.md.";

const approximatedMathProperties = APPROXIMATED_MATH.map((property) => ({
  object: "Math",
  property,
  message: `Math.${property} ${approximatedMathMessage}`,
}));

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

// Library code runs no Effect of its own: it returns the Effect, and the app's runtime runs it
// (ADR-0017). The `...With` forms are left alone: they are how plain code a host calls runs an
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
  'Library code runs no Effect itself: return the Effect, and the app\'s runtime runs it. Plain code that a host calls captures a runner once (FiberHandle.runtime, or Effect.context with Effect.runForkWith). See "Where plain code and Effect meet" in AGENTS.md.';

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

// Which entry of the arcadekit package may import which (ADR-0018). Core and input stand alone.
// game steps with core's clock and collects events in core's buffer. net seeds its test network
// with core's Rng, and imports game: a lockstep session is a host of a declared simulation, so it
// steps a `Game.Loop` and reads one player's input Schema from the simulation's
// `Game.PlayerInputs`, and the Co-op client draws on game's frame loop (ADR-0020). foldkit's tests
// drive a real engine from game; its own code only names the engine's shape. Adding an arrow
// here is a design decision: say why in the PR.
const KIT_SRC = "packages/arcadekit/src";
const KIT_TEST = "packages/arcadekit/test";
const ENTRY_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  core: [],
  input: [],
  content: [],
  save: [],
  audio: [],
  "render-three": [],
  game: ["core"],
  net: ["core", "game"],
  foldkit: ["game"],
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
    // (docs/code-style.md, "The doc comment"). `@since` is a standard tag; `@category` is Effect's.
    "jsdoc/check-tag-names": ["error", { definedTags: ["category"] }],
  },
  overrides: [
    {
      // How a game writes a declaration (ADR-0020, docs/code-style.md).
      files: ["packages/**/*.ts", "apps/**/*.ts"],
      jsPlugins: ["./tools/lint/declaration.ts"],
      rules: {
        "declaration/named": "error",
        "declaration/class": "error",
        "declaration/inferred": "error",
        "declaration/plain-handler": "error",
        "declaration/create-first": "error",
      },
    },
    {
      // The kit's own builders. The one other function of the kit that returns a class makes
      // the Durable Object that Cloudflare runs.
      files: ["packages/arcadekit/src/**/*.ts"],
      excludeFiles: ["packages/arcadekit/src/net/worker/signalling-worker.ts"],
      jsPlugins: ["./tools/lint/declaration.ts"],
      rules: { "declaration/builder": "error" },
    },
    {
      // Where the kit and the genres refuse a mistake. A refusal throws `Error`, or `RangeError`
      // for a number out of range, never `TypeError` (docs/code-style.md, "Refusing a mistake").
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
      // value every peer steps on and the step input built from the players' inputs (ADR-0017).
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
      // Core holds the exact math a step calls (core/exact-math.ts, ADR-0011), and its timers, eases
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
      // "./ring"`), as Effect's own index is (docs/code-style.md, "An Effect module"), and its
      // modules import `effect`, so what it loads is counted in the hundreds. What a game imports
      // of it is what a bundler keeps.
      files: ENTRY_FILES.map((file) => `${KIT_SRC}/${file}.ts`),
      rules: { "oxc/no-barrel-file": "off" },
    },
    {
      // The entries of the one package keep the direction the nine packages had (ADR-0018), and
      // so do their tests, each in the folder of test/ that its entry has in src/.
      files: [
        "packages/arcadekit/src/**/*.ts",
        "packages/arcadekit/test/**/*.ts",
      ],
      jsPlugins: ["./tools/lint/entry-direction.ts"],
      rules: {
        "entry-direction/allowed": [
          "error",
          {
            packageName: "arcadekit",
            root: KIT_SRC,
            tests: KIT_TEST,
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
