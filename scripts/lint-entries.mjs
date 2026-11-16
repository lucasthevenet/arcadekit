// Checks what each built entry of arcadekit imports, in dist/: the promise an entry makes
// is about what a program that imports it has to have installed.
//
//   arcadekit/ecs      imports no package at all
//   arcadekit          imports Effect and nothing else
//   arcadekit/Browser  imports Effect and @effect/platform-browser
//
// It follows the chunks an entry imports, since what entries share is built once.
// Build first: pnpm build:packages && pnpm lint:packages
import { readFileSync } from "node:fs";
import path from "node:path";

const dist = path.join(import.meta.dirname, "../packages/arcadekit/dist");

const isEffect = (name) => name === "effect" || name.startsWith("effect/");
const entries = {
  "ecs.js": () => false,
  "index.js": isEffect,
  "Browser.js": (name) =>
    isEffect(name) || name.startsWith("@effect/platform-browser"),
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
    const text = readFileSync(path.join(dist, file), "utf-8");
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
for (const [entry, allowed] of Object.entries(entries)) {
  const packages = packagesOf(entry);
  const stray = packages.filter((name) => !allowed(name));
  if (stray.length > 0) {
    failed = true;
    console.error(`dist/${entry} must not import: ${stray.join(", ")}`);
  } else {
    console.log(
      `dist/${entry} imports ${packages.length === 0 ? "no package" : packages.join(", ")}`
    );
  }
}
if (failed) {
  process.exit(1);
}
