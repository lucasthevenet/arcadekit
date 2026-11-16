// Checks what each built entry of each package imports, in dist/: the promise an entry makes
// is about what a program that imports it has to have installed.
//
//   arcadekit/ecs                imports no package at all
//   arcadekit/Browser            imports Effect, and may import @effect/platform-browser
//   every other entry of it      imports Effect and nothing else
//
//   every entry of @arcadekit/three imports arcadekit, Effect and Three.js, and nothing else
//
// The entries are read from each package's `exports`. It follows the chunks an entry imports,
// since what entries share is built once.
// Build first: pnpm build:packages && pnpm lint:packages
import { readFileSync } from "node:fs";
import path from "node:path";

const isEffect = (name) => name === "effect" || name.startsWith("effect/");
const isArcadekit = (name) =>
  name === "arcadekit" || name.startsWith("arcadekit/");
const isThree = (name) => name === "three" || name.startsWith("three/");

const packages = [
  {
    dir: "arcadekit",
    allowedFor: (subpath) => {
      if (subpath === "./ecs") {
        return () => false;
      }
      if (subpath === "./Browser") {
        return (name) =>
          isEffect(name) || name.startsWith("@effect/platform-browser");
      }
      return isEffect;
    },
    summary: (entries, imports) =>
      `arcadekit/ecs no package, ${
        entries
          .filter((name) => imports.get(name).some((one) => !isEffect(one)))
          .join(", ") || "none"
      } a browser package, the rest Effect alone`,
  },
  {
    dir: "three",
    allowedFor: () => (name) =>
      isArcadekit(name) || isEffect(name) || isThree(name),
    summary: () => "arcadekit, Effect and Three.js, and nothing else",
  },
];

/** Every package a built file imports, itself or through the chunks it imports. */
const packagesOf = (dir, entry) => {
  const seen = new Set();
  const found = new Set();
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
        found.add(specifier);
      }
    }
  };
  visit(entry);
  return Array.from(found).toSorted();
};

let failed = false;
const lines = [];
for (const one of packages) {
  const dir = path.join(import.meta.dirname, "../packages", one.dir);
  const manifest = JSON.parse(
    readFileSync(path.join(dir, "package.json"), "utf-8")
  );
  const imports = new Map();
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const name =
      subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
    const found = packagesOf(dir, target.default);
    imports.set(name, found);
    const stray = found.filter((each) => !one.allowedFor(subpath)(each));
    if (stray.length > 0) {
      failed = true;
      console.error(`${name} must not import: ${stray.join(", ")}`);
    }
  }
  lines.push(
    `${manifest.name}: ${imports.size} entries import what they may: ${one.summary(Array.from(imports.keys()), imports)}.`
  );
}
if (failed) {
  process.exit(1);
}
console.log(lines.join("\n"));
