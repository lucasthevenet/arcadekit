import { defineConfig } from "oxlint";

// oxlint's default rules only (its "correctness" category): code that is
// outright wrong or useless. No style rules.
export default defineConfig({
  ignorePatterns: ["**/dist/**", "**/node_modules/**"],
  rules: {
    // A system or a handler is a generator even when it needs no service,
    // so it may have no `yield`.
    "eslint/require-yield": "off",
  },
});
