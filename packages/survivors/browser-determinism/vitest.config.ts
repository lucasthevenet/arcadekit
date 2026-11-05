import { defineConfig } from "vitest/config";

import { sourceCondition } from "../../../scripts/source-condition.ts";

// `pnpm test:browsers`: the long-run determinism scenario in Chromium, Firefox and WebKit. Not
// part of `pnpm test`, since it needs Playwright's browsers installed.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [sourceCondition()],
  test: {
    include: ["*.browsers.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
