// The entries of a package's tsdown build, read from its `exports`.
//
// Every subpath has a `source` condition naming its file in src/, and `types` and `default`
// naming what the build writes to dist/. The root entry "." is called "index", and a subpath
// such as "./ecs" is called "ecs", so the build writes dist/index.js and dist/index.d.ts,
// dist/ecs.js and dist/ecs.d.ts, and so on. A subpath whose dist paths don't match that name
// fails the build, so the map and the build can't drift apart.
//
// An import of another entry is written as an import of that entry's file in dist/, which the
// build leaves alone, as a program that imports both would. Rolldown links the modules of one
// build itself, and gives `import * as X` of one of them an object of its own, exported from X's
// file beside X's exports: `arcadekit/Transform3d` then exported `Transform3d_exports`, and the
// index's `Transform3d` was that object, not the module, with a type the module's isn't
// assignable to (#389).
import { readFileSync } from "node:fs";
import path from "node:path";

import type { TsdownPlugin } from "tsdown";

interface SubpathExport {
  readonly source: string;
  readonly types: string;
  readonly default: string;
}

export const entries = (dir: string): Record<string, string> => {
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
    const name = subpath === "." ? "index" : subpath.slice("./".length);
    const keys = Object.keys(target).join(",");
    if (
      !(subpath === "." || subpath.startsWith("./")) ||
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

/** Writes an import of another entry as an import of the file the build writes it to. */
export const entryImports = (dir: string): TsdownPlugin => {
  const src = path.join(dir, "src");
  const named = new Map(
    Object.entries(entries(dir)).map(([name, source]) => [
      path.join(dir, source),
      name,
    ])
  );
  // Where the build writes a module, from src/ to dist/ and without its extension: an entry
  // under its name, any other file where it is in src/.
  const written = (file: string): string =>
    named.get(file) ?? path.relative(src, file).replace(/\.ts$/u, "");
  // An entry that is a module, not one that gathers them, src/index.ts or src/ecs/index.ts: the
  // source never imports one of those, and the declarations build writes a type one exports as
  // `import("./ecs").Frozen<T>`, which it would leave as "./ecs", a folder Node can't import.
  const isModule = (file: string): boolean =>
    named.has(file) && path.basename(file) !== "index.ts";
  return {
    name: "arcadekit:entry-imports",
    async resolveId(source, importer, options) {
      if (importer === undefined || !source.startsWith(".")) {
        return null;
      }
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      // The declarations build names a module's declarations src/X.d.ts.
      const from = importer.replace(/\.d\.ts$/u, ".ts");
      if (resolved === null || resolved.id === from || !isModule(resolved.id)) {
        return null;
      }
      const to = path.relative(
        path.dirname(written(from)),
        written(resolved.id)
      );
      return {
        id: `${to.startsWith(".") ? "" : "./"}${to}.js`,
        external: true,
      };
    },
  };
};
