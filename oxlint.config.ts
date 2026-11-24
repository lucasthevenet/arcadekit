import { defineConfig } from "oxlint";

// The rules Alchemy (github.com/alchemy-run/alchemy, oxlint.config.ts) and
// Foldkit (github.com/foldkit/foldkit, .oxlintrc.json and .oxlintrc.effect.json)
// lint with: oxlint's default rules (its "correctness" category), type-aware;
// the Effect rules of @effect/tsgo, which `effect-tsgo oxlint` adds to oxlint;
// Alchemy's type-aware TypeScript rules; Foldkit's import sorting and its
// refusal of `any`; and unused names allowed when they start with `_`, as both
// have it. Then arcadekit's own:
// its file names, and its plugin, tooling/lint/plugin.ts, on the sources of the
// published packages and, for the code of the tick, on their examples and
// benchmarks too.
export default defineConfig({
  options: {
    reportUnusedDisableDirectives: "error",
    typeAware: true,
    typeCheck: false,
  },
  plugins: [
    "import",
    "effecttsgo",
    "typescript",
    "node",
    "unicorn",
    "oxc",
    "vitest",
  ],
  ignorePatterns: ["**/dist/**", "**/node_modules/**"],
  jsPlugins: ["./tooling/lint/plugin.ts"],
  rules: {
    "no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      },
    ],
    // A system or a handler is a generator even when it needs no service,
    // so it may have no `yield`.
    "eslint/require-yield": "off",
    "sort-imports": [
      "error",
      { ignoreDeclarationSort: true, ignoreCase: false },
    ],
    // Foldkit's, everywhere: no `any`.
    "typescript/no-explicit-any": "error",

    // Alchemy's, as it has them.
    "effecttsgo/abort-controller-in-effect": "error",
    "effecttsgo/acquire-release-disposable": "error",
    "effecttsgo/all-of-map-to-for-each": "error",
    "effecttsgo/any-unknown-in-error-context": "error",
    "effecttsgo/catch-all-tag-dispatch-to-catch-tag": "error",
    "effecttsgo/catch-all-to-map-error": "error",
    "effecttsgo/catch-chain-to-first-success-of": "error",
    "effecttsgo/catch-conditional-refail-to-catch-if": "error",
    "effecttsgo/catch-die-to-or-die": "error",
    "effecttsgo/catch-if-tag-to-catch-tag": "error",
    "effecttsgo/catch-refail-to-tap-error": "error",
    "effecttsgo/catch-tag-to-catch-reason": "error",
    "effecttsgo/catch-to-ignore": "error",
    "effecttsgo/catch-to-or-else-succeed": "error",
    "effecttsgo/catch-unfailable-effect": "error",
    "effecttsgo/class-self-mismatch": "error",
    "effecttsgo/crypto-random-uuid-in-effect": "error",
    "effecttsgo/duplicate-package": "error",
    "effecttsgo/effect-do-notation": "error",
    "effecttsgo/effect-fn-iife": "error",
    "effecttsgo/effect-fn-implicit-any": "error",
    "effecttsgo/effect-fn-opportunity": "error",
    "effecttsgo/effect-gen-uses-adapter": "error",
    "effecttsgo/effect-in-failure": "error",
    "effecttsgo/effect-in-void-success": "error",
    "effecttsgo/effect-map-flatten": "error",
    "effecttsgo/effect-map-void": "error",
    "effecttsgo/effect-sleep-zero-to-yield-now": "error",
    "effecttsgo/effect-succeed-with-void": "error",
    "effecttsgo/error-payload-shadows-name": "error",
    "effecttsgo/experimental-api-usage": "error",
    "effecttsgo/extends-native-error": "error",
    "effecttsgo/flat-map-conditional-to-filter-or-fail": "off",
    "effecttsgo/flat-map-ignored-param-to-and-then": "error",
    "effecttsgo/flat-map-to-map": "error",
    "effecttsgo/flat-map-to-tap": "error",
    "effecttsgo/floating-effect": "error",
    "effecttsgo/floating-effect-in-vitest": "error",
    "effecttsgo/generic-effect-services": "error",
    "effecttsgo/global-console-in-effect": "error",
    "effecttsgo/global-date-in-effect": "error",
    "effecttsgo/global-error-in-effect-catch": "error",
    "effecttsgo/global-error-in-effect-failure": "error",
    "effecttsgo/global-fetch-in-effect": "error",
    "effecttsgo/global-random-in-effect": "error",
    "effecttsgo/global-timers-in-effect": "error",
    "effecttsgo/instance-of-schema": "error",
    "effecttsgo/layer-merge-all-with-dependencies": "off",
    // `XProvider()`, `providers()` and other Layer factories stay functions: they
    // are public API, return a fresh Layer per call, and avoid import-time builds.
    "effecttsgo/lazy-effect": "off",
    "effecttsgo/lazy-promise-in-effect-sync": "error",
    "effecttsgo/leaking-requirements": "off",
    "effecttsgo/map-some-to-as-some": "error",
    "effecttsgo/match-effect-to-map-both": "error",
    "effecttsgo/match-effect-to-match": "error",
    "effecttsgo/missed-pipeable-opportunity": "error",
    "effecttsgo/missing-effect-context": "error",
    "effecttsgo/missing-effect-error": "error",
    "effecttsgo/missing-effect-service-dependency": "error",
    "effecttsgo/missing-layer-context": "error",
    "effecttsgo/missing-return-yield-star": "error",
    "effecttsgo/missing-star-in-yield-effect-gen": "error",
    "effecttsgo/multiple-catch-tag": "error",
    "effecttsgo/multiple-effect-provide": "error",
    "effecttsgo/nested-effect-gen-yield": "error",
    "effecttsgo/new-schema-class": "error",
    "effecttsgo/non-object-effect-service-type": "error",
    "effecttsgo/obsolete-match-import": "error",
    "effecttsgo/obsolete-schema-import": "error",
    "effecttsgo/option-match-to-from-option": "error",
    "effecttsgo/outdated-api": "error",
    "effecttsgo/overridden-schema-constructor": "error",
    "effecttsgo/prefer-barrel-import": "error",
    "effecttsgo/prefer-namespace-import": "error",
    "effecttsgo/prefer-schema-type-property": "error",
    "effecttsgo/prefer-succeed-some-or-none": "error",
    "effecttsgo/prefer-typed-schema-decoder": "error",
    "effecttsgo/prefer-unsafe-constructor": "error",
    "effecttsgo/process-env-in-effect": "error",
    "effecttsgo/promise-in-effect-success": "error",
    "effecttsgo/provide-layer-succeed-to-provide-service": "error",
    "effecttsgo/race-first-with-sleep-to-timeout": "error",
    "effecttsgo/redundant-map-error": "error",
    "effecttsgo/redundant-or-die": "error",
    "effecttsgo/redundant-schema-tag-identifier": "error",
    "effecttsgo/return-effect-in-gen": "off",
    "effecttsgo/run-effect-inside-effect": "error",
    "effecttsgo/run-of-exit-to-run-exit": "error",
    "effecttsgo/schema-class-missing-brand": "off",
    "effecttsgo/schema-class-object-literal": "error",
    "effecttsgo/schema-literal-non-finite": "error",
    "effecttsgo/schema-number": "off",
    "effecttsgo/schema-opaque-instance-member": "error",
    "effecttsgo/schema-struct-with-tag": "error",
    "effecttsgo/schema-sync": "error",
    "effecttsgo/schema-sync-in-effect": "error",
    "effecttsgo/schema-union-of-literals": "error",
    "effecttsgo/scope-in-layer-effect": "error",
    "effecttsgo/service-not-as-class": "error",
    // Most `Effect.provide(layer)` sites are deliberate: runtime bridges and CLI
    // entry points, plus credential/client layers that can only be built per
    // call from runtime data (e.g. `accountLayer(creds)`, `fromApiKey(token)`).
    // Moving those to an entry point would mean ~170 disable comments.
    "effecttsgo/strict-effect-provide": "off",
    "effecttsgo/sync-to-succeed": "error",
    "effecttsgo/timeout-catch-tag-to-timeout-or-else": "error",
    "effecttsgo/try-catch-in-effect-gen": "error",
    "effecttsgo/unknown-in-effect-catch": "error",
    "effecttsgo/unnecessary-arrow-block": "error",
    "effecttsgo/unnecessary-effect-gen": "error",
    "effecttsgo/unnecessary-fail-yieldable-error": "error",
    "effecttsgo/unnecessary-pipe": "error",
    "effecttsgo/unnecessary-pipe-chain": "error",
    "effecttsgo/unnecessary-typeof-type": "error",
    "effecttsgo/unsafe-effect-type-assertion": "error",
    "effecttsgo/unstable-api-usage": "off",

    "typescript/await-thenable": "error",
    "typescript/no-array-delete": "error",
    "typescript/no-base-to-string": "error",
    "typescript/no-duplicate-enum-values": "error",
    "typescript/no-duplicate-type-constituents": "error",
    "typescript/no-extra-non-null-assertion": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-for-in-array": "error",
    "typescript/no-implied-eval": "error",
    "typescript/no-meaningless-void-operator": "error",
    "typescript/no-misused-new": "off",
    "typescript/no-misused-spread": "error",
    // TODO: fix all violations of this
    "typescript/no-non-null-asserted-optional-chain": "off",
    "typescript/no-redundant-type-constituents": "error",
    "typescript/no-this-alias": "error",
    "typescript/no-unnecessary-parameter-property-assignment": "error",
    "typescript/no-unsafe-declaration-merging": "error",
    "typescript/no-unsafe-unary-minus": "error",
    // Resources may be declared without props, so lifecycle `news`/`olds`
    // can be undefined at runtime even though their types say otherwise.
    "typescript/no-useless-default-assignment": "off",
    "typescript/no-useless-empty-export": "error",
    "typescript/no-wrapper-object-types": "error",
    "typescript/prefer-as-const": "error",
    "typescript/prefer-namespace-keyword": "error",
    "typescript/require-array-sort-compare": "error",
    "typescript/restrict-template-expressions": "error",
    "typescript/triple-slash-reference": "error",
    "typescript/unbound-method": "error",

    "unicorn/no-new-array": "error",
    "unicorn/no-useless-fallback-in-spread": "error",
    "unicorn/no-useless-length-check": "error",
    "unicorn/no-useless-spread": "error",
    "unicorn/prefer-string-starts-ends-with": "error",

    // An expect that runs on some paths alone passes on the others.
    "vitest/no-conditional-expect": "error",
    // A test with no expect checks nothing, unless through a helper that
    // expects, which is named expect<Something>.
    "vitest/expect-expect": [
      "error",
      { assertFunctionNames: ["expect", "expect*", "assert", "assert.*"] },
    ],
    // What a toThrow is to throw is said, or it passes for any error.
    "vitest/require-to-throw-message": "error",
    // Vitest's expect takes a message as its second argument.
    "vitest/valid-expect": ["error", { maxArgs: 2 }],
  },
  overrides: [
    // Files are named as Effect names its own. A module, which an entry is,
    // is PascalCase, as it is imported: arcadekit/Query, and
    // arcadekit/net/Session in a folder. So is the test of one,
    // test/Query.test.ts. Everything else is camelCase: what a module keeps
    // to itself in a folder, as the storage core behind arcadekit/ecs is, a
    // test's helpers, the benchmarks and the examples. index.ts and the
    // files a tool names keep their names.
    {
      files: ["packages/**"],
      rules: {
        "unicorn/filename-case": [
          "error",
          {
            case: "camelCase",
            ignore: [
              String.raw`^index\.ts$`,
              String.raw`\.config\.ts$`,
              String.raw`^alchemy\.run\.ts$`,
            ],
          },
        ],
      },
    },
    {
      files: ["packages/*/src/*.ts", "packages/*/test/**/*.test.ts"],
      rules: {
        "unicorn/filename-case": [
          "error",
          { case: "pascalCase", ignore: [String.raw`^index\.ts$`] },
        ],
      },
    },
    // A folder of src/ holds either: modules, and what a module keeps to
    // itself. test/Entries.test.ts holds that each module is an entry and
    // that every other file is behind one.
    {
      files: ["packages/*/src/*/**/*.ts"],
      rules: {
        "unicorn/filename-case": [
          "error",
          {
            cases: { camelCase: true, pascalCase: true },
            ignore: [String.raw`^index\.ts$`],
          },
        ],
      },
    },
    {
      files: ["packages/*/src/**"],
      rules: {
        "arcadekit/entry-imports": "error",
        "arcadekit/no-page": "error",
        "arcadekit/no-code-from-text": "error",
        "arcadekit/top-level-classes": "error",
      },
    },
    {
      // The code of the tick keeps what it changes in the world, except in
      // the tests, which record what systems did in arrays outside them.
      files: ["packages/**"],
      excludeFiles: ["packages/*/test/**"],
      rules: { "arcadekit/no-outside-state": "error" },
    },
    {
      // An id is converted to and from its number in one place, which the
      // tests may call too.
      files: ["packages/**"],
      excludeFiles: [
        "packages/arcadekit/src/ecs/component.ts",
        "packages/*/test/**",
      ],
      rules: { "arcadekit/id-casts": "error" },
    },
    {
      // Where the app runs plugins, systems, handlers and scripts of any
      // type: their types can't follow them into one app, and a few casts
      // claim them back. Off until a second wave, with
      // typescript/consistent-type-assertions.
      files: [
        "packages/arcadekit/src/App.ts",
        // Where an app is put together, which was in App.ts.
        "packages/arcadekit/src/Build.ts",
        "packages/arcadekit/src/Plugin.ts",
        // The turns of those systems, which were in App.ts.
        "packages/arcadekit/src/Schedule.ts",
        // The run of a handler, which was in App.ts.
        "packages/arcadekit/src/Inbox.ts",
        // The runs of the stages, which were in App.ts.
        "packages/arcadekit/src/Loop.ts",
      ],
      rules: {
        "effecttsgo/any-unknown-in-error-context": "off",
        "effecttsgo/unsafe-effect-type-assertion": "off",
      },
    },
    {
      // A snapshot's format is written once and read once, in
      // src/ecs/format.ts: nothing else puts a byte into a snapshot or takes
      // one out, so a change to the format is made there alone.
      files: ["packages/*/src/**"],
      excludeFiles: [
        "packages/arcadekit/src/ecs/format.ts",
        "packages/arcadekit/src/ecs/snapshot.ts",
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["**/snapshot"],
                importNames: ["Reader", "Writer", "readColumn", "writeColumn"],
                message:
                  "Only src/ecs/format.ts reads and writes the bytes of a snapshot. Give `read` a target or `write` a source, as World.loading and World.snapshotOf do, and change the format there.",
              },
            ],
          },
        ],
      },
    },
    {
      // The storage core is plain TypeScript, with no Effect: its errors are
      // thrown, and App turns them into tagged ones.
      files: ["packages/arcadekit/src/ecs/**"],
      rules: { "effecttsgo/extends-native-error": "off" },
    },
    {
      // A schema field's codec is called by the storage core, in a snapshot
      // or a hash, which throws what it can't encode.
      files: ["packages/arcadekit/src/Field.ts"],
      rules: { "effecttsgo/schema-sync": "off" },
    },
  ],
});
