import { defineConfig } from "vite";

import { sourceCondition } from "../../tooling/build/source-condition.ts";

// arcadekit is read from its src/, so the page needs no build of it.
export default defineConfig({
  plugins: [sourceCondition()],
});
