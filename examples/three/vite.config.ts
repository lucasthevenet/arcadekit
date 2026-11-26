import { defineConfig } from "vite";

import { sourceCondition } from "../../tooling/build/source-condition.ts";

// arcadekit and @arcadekit/three are read from their src/, so the page needs no build of them.
export default defineConfig({
  plugins: [sourceCondition()],
});
