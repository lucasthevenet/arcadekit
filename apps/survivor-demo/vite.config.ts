import { defineConfig } from "vite";

import { sourceCondition } from "../../scripts/source-condition.ts";

export default defineConfig({
  // The kit from src/, with no build.
  plugins: [sourceCondition()],
  build: {
    target: "es2022",
    // Three.js alone is ~550 kB minified (~135 kB gzipped); that's expected.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Keep Three.js in its own file so game code updates don't bust its cache.
        manualChunks: (id) =>
          id.includes("node_modules/three") ? "three" : undefined,
      },
    },
  },
});
