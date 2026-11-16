// Checks what each built entry of arcadekit imports, in dist/: the promise an entry makes
// is about what a program that imports it has to have installed.
//
//   arcadekit/ecs      imports no package at all
//   arcadekit/Browser  imports Effect, and may import @effect/platform-browser
//   every other entry  imports Effect and nothing else
//
// The entries are read from the package's `exports`. It follows the chunks an entry imports,
// since what entries share is built once.
// Build first: pnpm build:packages && pnpm lint:packages
import { readFileSync } from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dirname, "../packages/arcadekit");
const manifest = JSON.parse(
  readFileSync(path.join(dir, "package.json"), "utf-8")
);

const isEffect = (name) => name === "effect" || name.startsWith("effect/");
const allowedFor = (subpath) => {
  if (subpath === "./ecs") {
    return () => false;
  }
  if (subpath === "./Browser") {
    return (name) =>
      isEffect(name) || name.startsWith("@effect/platform-browser");
  }
  return isEffect;
};

/** Every package a built file imports, itself or through the chunks it imports. */
const packagesOf = (entry) => {
  const seen = new Set();
  const packages = new Set();
  const visit = (file) => {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    const text = readFileSync(path.join(dir, file), "utf-8");
    const pattern =
      /(?:^|[;\n])\s*(?:import|export)\s*(?:[^"';]*?\bfrom\s*)?["']([^"']+)["']/gu;
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        visit(path.join(path.dirname(file), specifier));
      } else {
        packages.add(specifier);
      }
    }
  };
  visit(entry);
  return Array.from(packages).toSorted();
};

let failed = false;
const browser = [];
for (const [subpath, target] of Object.entries(manifest.exports)) {
  const name = subpath === "." ? "arcadekit" : `arcadekit/${subpath.slice(2)}`;
  const packages = packagesOf(target.default);
  const stray = packages.filter((one) => !allowedFor(subpath)(one));
  if (stray.length > 0) {
    failed = true;
    console.error(`${name} must not import: ${stray.join(", ")}`);
  }
  if (packages.some((one) => !isEffect(one))) {
    browser.push(name);
  }
}
if (failed) {
  process.exit(1);
}
console.log(
  `${Object.keys(manifest.exports).length} entries import what they may: arcadekit/ecs no package, ${browser.join(", ") || "none"} a browser package, the rest Effect alone.`
);
