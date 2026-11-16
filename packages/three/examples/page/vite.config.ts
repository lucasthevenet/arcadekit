import { defineConfig } from "vite";

import { sourceCondition } from "../../../../scripts/source-condition";

// `pnpm --filter @arcadekit/three page`. arcadekit is read from its src/, so the page needs
// no build of it.
export default defineConfig({
  plugins: [sourceCondition()],
});
