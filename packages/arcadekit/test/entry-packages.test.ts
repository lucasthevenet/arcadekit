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
// Every entry may import `effect`, the package's one required peer. `three`, `foldkit` and `@effect/platform-browser` are optional peers, each allowed
// only in the entry it is for, so a game that skips one still gets every other entry whole.
// arcadekit/net/worker runs on Cloudflare, so it alone may import the runtime's own
// `cloudflare:workers` module, which is not a package: the optional `@cloudflare/workers-types`
// peer has its types. An entry that only a test or a script imports runs in Node, so it may
// import a Node built-in (`node:zlib`), which is no package either: NODE_ENTRIES lists them.
//
// `pnpm test` checks src/, and dist/ too when it has been built. `pnpm lint:packages` runs this
// file after a build with ARCADEKIT_REQUIRE_DIST set, so a missing dist/ fails there.

const packageDir = path.resolve(import.meta.dirname, "..");

// The packages each entry may import. Adding one here is a design decision: say why in the PR.
const ENTRY_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  core: ["effect"],
  input: ["effect"],
  content: ["effect"],
  "content/browser": ["effect"],
  save: ["effect"],
  "save/browser": ["effect", "@effect/platform-browser"],
  audio: ["effect"],
  "audio/browser": ["effect"],
  "render-three": ["effect", "three"],
  "render-three/testing": ["effect", "three", "node:zlib"],
  game: ["effect"],
  "game/browser": ["effect"],
  "game/scenario": ["effect"],
  "game/testing": ["effect"],
  net: ["effect"],
  "net/browser": ["effect"],
  "net/testing": ["effect"],
  "net/signalling": ["effect"],
  "net/worker": ["effect", "cloudflare:workers"],
  foldkit: ["effect", "foldkit"],
};

// The entries that only a test or a script imports. They run in Node, never in a browser or a
// Worker, so they may import its built-ins, and tsconfig.node.json checks them with its types.
const NODE_ENTRIES: readonly string[] = ["render-three/testing"];

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

/**
 * A file's text without its comments, so an example in a doc comment (`import { Ring } from
 * "arcadekit/core"`) is not read as an import. A line comment starts after a space or a line's
 * start, so the `//` of a URL in a string stays.
 */
const withoutComments = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\/|(?<=^|\s)\/\/.*$/gmu, "");

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
    for (const match of withoutComments(readFileSync(file, "utf-8")).matchAll(
      SPECIFIER
    )) {
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

const peers = (): readonly string[] => Object.keys(peerDependencies);

/**
 * The names an entry's public file exports, read from its `export` statements: a list in braces,
 * where a name after `as` is the one exported, or a `const`. Such a file exports in no other way.
 */
const exportedBy = (entry: string): readonly string[] => {
  const text = readFileSync(
    path.join(packageDir, exportsMap[entry]?.source ?? ""),
    "utf-8"
  );
  const listed = [...text.matchAll(/^export (?:type )?\{(?<names>[^}]*)\}/gmu)]
    .flatMap(({ groups }) => (groups?.names ?? "").split(","))
    .map((item) => item.trim().split(/\s+/u).at(-1) ?? "")
    .filter((name) => name !== "");
  const declared = [...text.matchAll(/^export const (?<name>\w+)/gmu)].map(
    ({ groups }) => groups?.name ?? ""
  );
  return [...listed, ...declared].toSorted();
};

/** The folders one of the package's tsconfig files lists under a key, read with `list`. */
const foldersOf = (file: string, list: RegExp): readonly string[] =>
  (
    list.exec(readFileSync(path.join(packageDir, file), "utf-8"))?.groups
      ?.list ?? ""
  )
    .split(",")
    .map((item) => item.trim().replaceAll('"', ""));

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

  it("allows only the package's peers, Cloudflare's runtime modules and Node's built-ins", () => {
    const others = Object.values(ENTRY_PACKAGES)
      .flat()
      .filter(
        (name) =>
          !peers().includes(name) &&
          !name.startsWith("cloudflare:") &&
          !name.startsWith("node:")
      );
    expect(others).toStrictEqual([]);
  });

  it("allows a Node built-in only in an entry that only a test or a script imports", () => {
    const entries = Object.entries(ENTRY_PACKAGES)
      .filter(([, names]) => names.some((name) => name.startsWith("node:")))
      .map(([entry]) => entry);
    expect(entries).toStrictEqual(NODE_ENTRIES);
    // What tsconfig.node.json checks with Node's types, tsconfig.json leaves out.
    for (const entry of NODE_ENTRIES) {
      expect(
        foldersOf("tsconfig.node.json", /"include": \[(?<list>[^\]]*)\]/u)
      ).toContain(`src/${entry}`);
      expect(
        foldersOf("tsconfig.json", /"exclude": \[(?<list>[^\]]*)\]/u)
      ).toContain(`src/${entry}`);
    }
  });

  it("allows Cloudflare's runtime modules only in arcadekit/net/worker", () => {
    const entries = Object.entries(ENTRY_PACKAGES)
      .filter(([, names]) =>
        names.some((name) => name.startsWith("cloudflare:"))
      )
      .map(([entry]) => entry);
    expect(entries).toStrictEqual(["net/worker"]);
    expect(peers()).toContain("@cloudflare/workers-types");
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
      path.join(packageDir, exportsMap["./game/browser"]?.source ?? "")
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

describe("arcadekit/game/browser", () => {
  // A file imports one of the two entries as `Game`. A package that emits its types names the
  // kit's types through the entry it imports, so a type that only the other entry exports is an
  // error there (TS2742), though every project of this repository compiles.
  it("exports everything arcadekit/game does", () => {
    const game = exportedBy("./game");
    const browser = new Set(exportedBy("./game/browser"));
    // A `const` and a listed type: the read finds both kinds of export.
    expect(game).toContain("Simulation");
    expect(game).toContain("SimulationClass");
    expect(
      game.filter((name) => !browser.has(name)),
      "src/game/browser.ts must export every name src/game/index.ts does: add these to its lists"
    ).toStrictEqual([]);
  });
});
