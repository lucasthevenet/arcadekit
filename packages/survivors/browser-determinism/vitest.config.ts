import { defineConfig } from "vitest/config";

// `pnpm test:browsers`: the long-run determinism scenario in Chromium, Firefox and WebKit. Not
// part of `pnpm test`, since it needs Playwright's browsers installed.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["*.browsers.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
