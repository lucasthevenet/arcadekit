import { defineConfig } from "oxlint";
import { recommended as effect } from "oxlint-plugin-effect/presets/recommended";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

// Ultracite's presets (core, Vitest, anti-slop), the recommended rules of
// oxlint-plugin-effect, and the rules of arcadekit's own plugin,
// tooling/lint/plugin.ts, on the sources of the published packages.
export default defineConfig({
  env: core.env,
  extends: [core, vitest, antiSlop],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: ["./tooling/lint/plugin.ts", "oxlint-plugin-effect/plugin"],
  rules: {
    ...effect,
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
