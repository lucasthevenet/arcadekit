// The tsdown build every published kit package shares (ADR-0016). Each package's
// tsdown.config.ts calls it with its own folder.
//
// The entries come from the package's `exports`: every subpath has a `source` condition naming
// its file in src/, and `types` and `default` naming what this build writes to dist/. The entry
// for "." is called "index" and the one for "./browser" is called "browser", so it writes
// dist/index.js and dist/index.d.ts, and so on. A subpath whose dist paths don't match that
// name fails the build, so the map and the build can't drift apart.
import { readFileSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "tsdown";
import type { UserConfig } from "tsdown";

interface SubpathExport {
  readonly source: string;
  readonly types: string;
  readonly default: string;
}

const entryName = (subpath: string): string =>
  subpath === "." ? "index" : subpath.slice("./".length);

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
    const name = entryName(subpath);
    const keys = Object.keys(target).join(",");
    if (
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

export const kitPackage = (dir: string): UserConfig =>
  defineConfig({
    cwd: dir,
    entry: entries(dir),
    format: "esm",
    platform: "neutral",
    target: "es2022",
    outDir: "dist",
    clean: true,
    sourcemap: true,
    // Declarations come from oxc, one file at a time; the kit packages turn on
    // isolatedDeclarations so every export has the explicit type it needs.
    dts: { generator: "oxc", sourcemap: true },
    // dependencies and peerDependencies stay imports (tsdown's default). Bundling anything
    // else from node_modules fails the build.
    deps: { onlyBundle: [] },
  });
