// The build of @arcadekit/three, as the kit's own: see packages/arcadekit/tsdown.config.ts.
//
// arcadekit, Effect and Three.js are peer dependencies, so they stay imports: a game has one
// copy of each, and a component or a service of arcadekit's is the same object here as there.
import { defineConfig } from "tsdown";
import type { UserConfig } from "tsdown";

import { entries, entryImports } from "../../tooling/build/tsdown-entries.ts";

const config: UserConfig = defineConfig({
  cwd: import.meta.dirname,
  entry: entries(import.meta.dirname),
  plugins: [entryImports(import.meta.dirname)],
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outDir: "dist",
  // One file for each source file, as the kit's own.
  unbundle: true,
  clean: true,
  sourcemap: true,
  dts: { generator: "tsgo", sourcemap: true },
  deps: { neverBundle: [/^node:/u], onlyBundle: [] },
});

export default config;
