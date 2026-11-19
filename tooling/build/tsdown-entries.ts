// The entries of a package's tsdown build, read from its `exports`.
//
// Every subpath has a `source` condition naming its file in src/, and `types` and `default`
// naming what the build writes to dist/. The root entry "." is called "index", and a subpath
// such as "./ecs" is called "ecs", so the build writes dist/index.js and dist/index.d.ts,
// dist/ecs.js and dist/ecs.d.ts, and so on. A subpath whose dist paths don't match that name
// fails the build, so the map and the build can't drift apart.
import { readFileSync } from "node:fs";
import path from "node:path";

interface SubpathExport {
  readonly source: string;
  readonly types: string;
  readonly default: string;
}

export const entries = (dir: string): Record<string, string> => {
  const pkg = JSON.parse(
    readFileSync(path.join(dir, "package.json"), "utf8")
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
