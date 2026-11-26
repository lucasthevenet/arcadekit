import { configDefaults, defineConfig } from "vitest/config";

import { sourceCondition } from "./tooling/build/source-condition.ts";

// `pnpm test`. The kit is tested from src/, with no build.
export default defineConfig({
  plugins: [sourceCondition()],
  test: {
    // A worktree an agent works in is a checkout of its own, with its own run.
    exclude: [...configDefaults.exclude, ".claude/worktrees/**"],
    // What every test file starts with: see the file.
    setupFiles: [
      new URL("./tooling/build/vitest-setup.ts", import.meta.url).pathname,
    ],
  },
});
