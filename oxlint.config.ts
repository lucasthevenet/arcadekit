import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  env: core.env,
  extends: [core, vitest],
  ignorePatterns: core.ignorePatterns,
  rules: {
    // Effect Schema convention: `const X = Schema.Struct(...)` + `type X = typeof X.Type`.
    "eslint/no-redeclare": "off",
    // Key order carries meaning (schema fields, config sections).
    "eslint/sort-keys": "off",
    // `Effect.gen(function* () { ... })` is the Effect idiom.
    "eslint/func-names": "off",
    // Effect APIs take callbacks by design.
    "promise/prefer-await-to-callbacks": "off",
    // Switches over unions are checked for exhaustiveness by TypeScript; a
    // `default` branch would hide a missing case.
    "eslint/default-case": "off",
  },
});
