import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// arcadekit/core and arcadekit/input need no Effect, so a game can use them without it
// (ADR-0017). When they were packages of their own, their package.json said so: `effect` was not
// installed for them. In the one package it is a peer of the whole, so this test says it instead
// (ADR-0018): it follows every import from each of the two entries, in src/ and in the built
// dist/, and fails if any file it reaches imports `effect` or an `@effect/*` package.
//
// `pnpm test` checks src/, and dist/ too when it has been built. `pnpm lint:packages` runs this
// file after a build with ARCADEKIT_REQUIRE_DIST set, so a missing dist/ fails there.

const packageDir = path.resolve(import.meta.dirname, "..");

const EFFECT_FREE_ENTRIES = ["core", "input"] as const;

const exportsMap = (
  JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf-8")) as {
    readonly exports: Readonly<
      Record<string, { readonly source: string; readonly default: string }>
    >;
  }
).exports;

// Every module specifier in a file: `from "x"`, `import "x"` and `import("x")`.
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](?<specifier>[^"'\n]+)["']/gu;

const resolveRelative = (from: string, specifier: string): string => {
  const base = path.resolve(path.dirname(from), specifier);
  const found = [base, `${base}.ts`, path.join(base, "index.ts")].find(
    (candidate) => existsSync(candidate) && path.extname(candidate) !== ""
  );
  if (found === undefined) {
    throw new Error(`${from} imports "${specifier}", which is not a file`);
  }
  return found;
};

/** The packages a file imports, itself or through the files it imports. */
const packagesReachedFrom = (entryFile: string): readonly string[] => {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [entryFile];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const match of readFileSync(file, "utf-8").matchAll(SPECIFIER)) {
      const specifier = match.groups?.specifier ?? "";
      if (specifier.startsWith(".")) {
        queue.push(resolveRelative(file, specifier));
      } else {
        packages.add(specifier);
      }
    }
  }
  return [...packages].toSorted();
};

const isEffect = (specifier: string): boolean =>
  specifier === "effect" ||
  specifier.startsWith("effect/") ||
  specifier.startsWith("@effect/");

const distBuilt = existsSync(path.join(packageDir, "dist"));
const distRequired = process.env.ARCADEKIT_REQUIRE_DIST !== undefined;

describe.each(EFFECT_FREE_ENTRIES)("arcadekit/%s", (entry) => {
  const target = exportsMap[`./${entry}`];

  it("is an entry of the package", () => {
    expect(target).toBeDefined();
  });

  it("imports no effect from src/", () => {
    const packages = packagesReachedFrom(
      path.join(packageDir, target?.source ?? "")
    );
    expect(packages.filter(isEffect)).toStrictEqual([]);
  });

  it.skipIf(!distBuilt && !distRequired)("imports no effect from dist/", () => {
    const packages = packagesReachedFrom(
      path.join(packageDir, target?.default ?? "")
    );
    expect(packages.filter(isEffect)).toStrictEqual([]);
  });
});

describe("the walk", () => {
  it("finds effect in an entry that uses it", () => {
    const packages = packagesReachedFrom(
      path.join(packageDir, exportsMap["./runtime/browser"]?.source ?? "")
    );
    expect(packages.filter(isEffect)).toContain("effect");
  });
});
