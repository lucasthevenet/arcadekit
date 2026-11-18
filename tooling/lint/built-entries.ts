// Checks what each built entry of each package imports, in dist/, against entries.ts. The entries
// are read from each package's `exports`. It follows the chunks an entry imports, since what
// entries share is built once, and a shared chunk can bring an entry a package its sources never
// import: which Oxlint, reading the sources, cannot see.
// Build first: pnpm build:packages && pnpm lint:packages
import { readFileSync } from "node:fs";
import path from "node:path";

import { isEffect, packages } from "./entries.ts";

/** Every package a built file imports, itself or through the chunks it imports. */
const packagesOf = (dir: string, entry: string): string[] => {
  const seen = new Set<string>();
  const found = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    const text = readFileSync(path.join(dir, file), "utf-8");
    const pattern =
      /(?:^|[;\n])\s*(?:import|export)\s*(?:[^"';]*?\bfrom\s*)?["']([^"']+)["']/gu;
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1]!;
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
const lines: string[] = [];
for (const one of packages) {
  const dir = path.join(import.meta.dirname, "../../packages", one.dir);
  const manifest = JSON.parse(
    readFileSync(path.join(dir, "package.json"), "utf-8")
  ) as {
    readonly name: string;
    readonly exports: Readonly<Record<string, { readonly default: string }>>;
  };
  const imports = new Map<string, string[]>();
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const name =
      subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
    const rule = one.ofEntry(subpath);
    const found = packagesOf(dir, target.default);
    imports.set(name, found);
    const stray = found.filter((each) => !rule.may(each));
    if (stray.length > 0) {
      failed = true;
      console.error(
        `${name} must not import: ${stray.join(", ")}. ${rule.says}.`
      );
    }
  }
  const beyondEffect = Array.from(imports)
    .filter(([, found]) => found.some((each) => !isEffect(each)))
    .map(([name]) => name);
  lines.push(
    `${manifest.name}: ${imports.size} entries import what they may; beyond Effect: ${beyondEffect.join(", ") || "none"}.`
  );
}
if (failed) {
  process.exit(1);
}
console.log(lines.join("\n"));
