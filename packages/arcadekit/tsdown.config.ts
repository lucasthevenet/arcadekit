// The kit's tsdown build (ADR-0018).
//
// The entries come from the package's `exports`: every subpath has a `source` condition naming
// its file in src/, and `types` and `default` naming what this build writes to dist/. The entry
// for "./core" is called "core" and the one for "./net/browser" is called "net/browser", so it
// writes dist/core.js and dist/core.d.ts, dist/net/browser.js and dist/net/browser.d.ts, and so
// on. A subpath whose dist paths don't match that name fails the build, so the map and the build
// can't drift apart.
//
// All entries are one build, so what two entries share (game's Loop, which net's lockstep
// session also steps) is written once, to a chunk both import: a class or an Effect service is
// the same object whichever entry it is reached through.
import { readFileSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "tsdown";
import type { UserConfig } from "tsdown";

interface SubpathExport {
  readonly source: string;
  readonly types: string;
  readonly default: string;
}

const entries = (dir: string): Record<string, string> => {
  const pkg = JSON.parse(
    readFileSync(path.join(dir, "package.json"), "utf-8")
  ) as {
    readonly name: string;
    readonly exports: Readonly<Record<string, SubpathExport>>;
  };
  const result: Record<string, string> = {};
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    if (subpath === "./package.json") {
      continue;
    }
    const name = subpath.slice("./".length);
    const keys = Object.keys(target).join(",");
    if (
      !subpath.startsWith("./") ||
      keys !== "source,types,default" ||
      target.types !== `./dist/${name}.d.ts` ||
      target.default !== `./dist/${name}.js`
    ) {
      throw new Error(
        `${pkg.name}: exports["${subpath}"] must be { source, types: "./dist/${name}.d.ts", default: "./dist/${name}.js" }`
      );
    }
    result[name] = target.source;
  }
  return result;
};

const config: UserConfig = defineConfig({
  cwd: import.meta.dirname,
  entry: entries(import.meta.dirname),
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Declarations come from oxc, one file at a time; the package turns on isolatedDeclarations
  // so every export has the explicit type it needs.
  dts: { generator: "oxc", sourcemap: true },
  // peerDependencies stay imports (tsdown's default). Bundling anything else from node_modules
  // fails the build. `cloudflare:workers` is Cloudflare's runtime's own module, which only a
  // Worker has, so arcadekit/net/worker's import of it stays an import too. So does a `node:`
  // built-in, which an entry that only a test or a script imports may use: Node has it.
  deps: { onlyBundle: [], neverBundle: [/^cloudflare:/u, /^node:/u] },
});

export default config;
