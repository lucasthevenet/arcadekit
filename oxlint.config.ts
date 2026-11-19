import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

// Ultracite's presets (core, Vitest, anti-slop), the Effect rules of
// anti-slop (vendored in tooling/lint/anti-slop-effect), and the rules of
// arcadekit's own plugin, tooling/lint/plugin.ts, on the sources of the
// published packages.
export default defineConfig({
  env: core.env,
  extends: [core, vitest, antiSlop],
  ignorePatterns: [...core.ignorePatterns, "tooling/lint/anti-slop-effect/**"],
  jsPlugins: [
    "./tooling/lint/plugin.ts",
    {
      name: "anti-slop-effect",
      specifier: "./tooling/lint/anti-slop-effect/index.ts",
    },
  ],
  rules: {
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
    // A system or a handler is a generator even when it needs no service,
    // so it may have no `yield`.
    "eslint/require-yield": "off",
  },
  overrides: [
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
