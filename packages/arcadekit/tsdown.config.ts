// The kit's tsdown build.
//
// The entries come from the package's `exports`, read by scripts/tsdown-entries.ts: every
// subpath has a `source` condition naming its file in src/, and `types` and `default` naming
// what this build writes to dist/.
//
// All entries are one build, so what two entries share is written once, to a chunk both import:
// a class or an Effect service is the same object whichever entry it is reached through.
import { defineConfig } from "tsdown";
import type { UserConfig } from "tsdown";

import { entries } from "../../scripts/tsdown-entries.ts";

const config: UserConfig = defineConfig({
  cwd: import.meta.dirname,
  entry: entries(import.meta.dirname),
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Declarations come from the TypeScript compiler itself, so an export's type may be inferred
  // (a service class that extends a call, an object whose type is its value). tsgo reads the
  // options, declarationMap included, from tsconfig.json.
  dts: { generator: "tsgo", sourcemap: true },
  // peerDependencies stay imports (tsdown's default). Bundling anything else from node_modules
  // fails the build. `cloudflare:` runtime modules and `node:` built-ins stay imports too.
  deps: { neverBundle: [/^cloudflare:/u, /^node:/u], onlyBundle: [] },
});

export default config;
