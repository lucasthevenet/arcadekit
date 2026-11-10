import { defineConfig } from "vitest/config";

import { sourceCondition } from "./scripts/source-condition.ts";

// `pnpm test`. The kit is tested from src/, with no build (ADR-0016).
export default defineConfig({
  plugins: [sourceCondition()],
});
