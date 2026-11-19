// The entries of a package's tsdown build, read from its `exports`.
//
// Every subpath has a `source` condition naming its file in src/, and `types` and `default`
// naming what the build writes to dist/. The root entry "." is called "index", and a subpath
// such as "./ecs" is called "ecs", so the build writes dist/index.js and dist/index.d.ts,
// dist/ecs.js and dist/ecs.d.ts, and so on. A subpath whose dist paths don't match that name
// fails the build, so the map and the build can't drift apart.
import { readFileSync } from "node:fs";
import path from "node:path";

/** `value[key]` where `value` is an object, and undefined where it is not. */
const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

export const entries = (dir: string): Record<string, string> => {
  const pkg: unknown = JSON.parse(
    readFileSync(path.join(dir, "package.json"), "utf-8")
  );
  const packageName = String(fieldOf(pkg, "name"));
  const exports = fieldOf(pkg, "exports");
  if (typeof exports !== "object" || exports === null) {
    throw new Error(`${packageName}: package.json has no exports`);
  }
  const result: Record<string, string> = {};
  for (const subpath of Object.keys(exports)) {
    if (subpath === "./package.json") {
      continue;
    }
    const name = subpath === "." ? "index" : subpath.slice("./".length);
    const target: unknown = Reflect.get(exports, subpath);
    const source = fieldOf(target, "source");
    if (
      !(subpath === "." || subpath.startsWith("./")) ||
      typeof target !== "object" ||
      target === null ||
      Object.keys(target).join(",") !== "source,types,default" ||
      typeof source !== "string" ||
      fieldOf(target, "types") !== `./dist/${name}.d.ts` ||
      fieldOf(target, "default") !== `./dist/${name}.js`
    ) {
      throw new Error(
        `${packageName}: exports["${subpath}"] must be { source, types: "./dist/${name}.d.ts", default: "./dist/${name}.js" }`
      );
    }
    result[name] = source;
  }
  return result;
};
