import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Which packages each entry of arcadekit may import (ADR-0018). When the entries were packages
// of their own, each one's package.json said so: `effect` was not installed for core and input,
// nor `foldkit` for net. In the one package every peer is installed for every entry, so this test
// says it instead. It follows every import from each entry, in src/ and in the built dist/ (the
// JavaScript and the type files), and fails if a file it reaches imports a package the entry is
// not allowed.
//
// arcadekit/core and arcadekit/input are allowed none, so a game can use them without Effect
// (ADR-0017). `three`, `foldkit` and `@effect/platform-browser` are optional peers, each allowed
// only in the entry it is for, so a game that skips one still gets every other entry whole.
//
// `pnpm test` checks src/, and dist/ too when it has been built. `pnpm lint:packages` runs this
// file after a build with ARCADEKIT_REQUIRE_DIST set, so a missing dist/ fails there.

const packageDir = path.resolve(import.meta.dirname, "..");

// The packages each entry may import. Adding one here is a design decision: say why in the PR.
const ENTRY_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  core: [],
  input: [],
  content: ["effect"],
  "content/browser": ["effect"],
  save: ["effect"],
  "save/browser": ["effect", "@effect/platform-browser"],
  audio: ["effect"],
  "audio/browser": ["effect"],
  "render-three": ["effect", "three"],
  runtime: ["effect"],
  "runtime/browser": ["effect"],
  "runtime/testing": ["effect"],
  net: ["effect"],
  "net/browser": ["effect"],
  "net/signalling": ["effect"],
  foldkit: ["effect", "foldkit"],
};

interface EntryTarget {
  readonly source: string;
  readonly types: string;
  readonly default: string;
}

const { exports: exportsMap, peerDependencies } = JSON.parse(
  readFileSync(path.join(packageDir, "package.json"), "utf-8")
) as {
  readonly exports: Readonly<Record<string, EntryTarget>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
};

// Every module specifier in a file: `from "x"`, `import "x"` and `import("x")`. Only a dynamic
// import can be written with backticks; after `from` they are prose in a comment.
const SPECIFIER =
  /(?:(?:\bfrom\s*|\bimport\s*)["'](?<fixed>[^"'\s]+)["']|\bimport\s*\(\s*["'`](?<dynamic>[^"'`\s]+)["'`])/gu;

// A source file imports "./x" for x.ts; a built type file imports "./x.js" for x.d.ts.
const resolveRelative = (from: string, specifier: string): string => {
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = from.endsWith(".d.ts")
    ? [base.replace(/\.js$/u, ".d.ts")]
    : [base, `${base}.ts`, path.join(base, "index.ts")];
  const found = candidates.find(
    (candidate) => existsSync(candidate) && path.extname(candidate) !== ""
  );
  if (found === undefined) {
    throw new Error(`${from} imports "${specifier}", which is not a file`);
  }
  return found;
};

// "effect/unstable/http" is the package "effect"; "@effect/platform-browser/x" is
// "@effect/platform-browser".
const packageOf = (specifier: string): string =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

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
      const specifier = match.groups?.fixed ?? match.groups?.dynamic ?? "";
      if (specifier.startsWith(".")) {
        queue.push(resolveRelative(file, specifier));
      } else {
        packages.add(packageOf(specifier));
      }
    }
  }
  return [...packages].toSorted();
};

const distBuilt = existsSync(path.join(packageDir, "dist"));
const distRequired = process.env.ARCADEKIT_REQUIRE_DIST !== undefined;

describe("the table of entries", () => {
  it("names every entry of the package", () => {
    expect(Object.keys(ENTRY_PACKAGES).toSorted()).toStrictEqual(
      Object.keys(exportsMap)
        .map((entry) => entry.replace(/^\.\//u, ""))
        .toSorted()
    );
  });

  it("allows only the package's peers", () => {
    const peers = Object.keys(peerDependencies);
    const others = Object.values(ENTRY_PACKAGES)
      .flat()
      .filter((name) => !peers.includes(name));
    expect(others).toStrictEqual([]);
  });
});

describe.each(Object.entries(ENTRY_PACKAGES))(
  "arcadekit/%s",
  (entry, allowed) => {
    const target = exportsMap[`./${entry}`];
    const notAllowed = (file: string | undefined): readonly string[] =>
      packagesReachedFrom(path.join(packageDir, file ?? "")).filter(
        (name) => !allowed.includes(name)
      );

    it("imports only its packages from src/", () => {
      expect(notAllowed(target?.source)).toStrictEqual([]);
    });

    it.skipIf(!distBuilt && !distRequired)(
      "imports only its packages from dist/",
      () => {
        expect(notAllowed(target?.default)).toStrictEqual([]);
        expect(notAllowed(target?.types)).toStrictEqual([]);
      }
    );
  }
);

describe("the walk", () => {
  it("finds effect in an entry that uses it", () => {
    const packages = packagesReachedFrom(
      path.join(packageDir, exportsMap["./runtime/browser"]?.source ?? "")
    );
    expect(packages).toContain("effect");
  });

  it.skipIf(!distBuilt && !distRequired)(
    "follows the built type files' shared chunks",
    () => {
      const packages = packagesReachedFrom(
        path.join(packageDir, exportsMap["./net/browser"]?.types ?? "")
      );
      expect(packages).toContain("effect");
    }
  );
});
