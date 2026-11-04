import { defineConfig } from "vitest/config";

// The end-to-end tests (`pnpm test:e2e`): two browsers playing co-op. Not part of `pnpm test`.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
