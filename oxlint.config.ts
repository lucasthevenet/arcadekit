import { defineConfig } from "oxlint";

// oxlint's default rules (its "correctness" category): code that is outright wrong or useless.
// No style rules. And the rules of arcadekit's own plugin, tooling/lint/plugin.ts, on the sources
// of the published packages.
export default defineConfig({
  ignorePatterns: ["**/dist/**", "**/node_modules/**"],
  jsPlugins: ["./tooling/lint/plugin.ts"],
  rules: {
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
