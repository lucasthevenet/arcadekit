import { defineConfig } from "vitest/config";

import { sourceCondition } from "./scripts/source-condition.ts";

// `pnpm test`. The kit is tested from src/, with no build.
export default defineConfig({
  plugins: [sourceCondition()],
});
