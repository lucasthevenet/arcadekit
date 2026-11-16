import { describe, expect, it } from "vitest";

import * as Ecs from "../src/ecs/index";
import * as Main from "../src/index";

// Vite gives a test the text of files: the sources of the package, and its
// manifest. Declared here, since the tests are compiled with no types but
// their own.
declare global {
  interface ImportMeta {
    readonly glob: (
      pattern: string,
      options: {
        readonly query: "?raw";
        readonly import: "default";
        readonly eager: true;
      }
    ) => Record<string, string>;
  }
}

const sources = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const manifest = JSON.parse(
  Object.values(
    import.meta.glob("../package.json", {
      query: "?raw",
      import: "default",
      eager: true,
    })
  )[0]!
) as {
  readonly exports: Record<
    string,
    {
      readonly source: string;
      readonly types: string;
      readonly default: string;
    }
  >;
  readonly peerDependencies: Record<string, string>;
  readonly peerDependenciesMeta: Record<
    string,
    { readonly optional?: boolean }
  >;
};

/** What a file imports from, type-only imports among them. */
const imported = (text: string): string[] => {
  const found: string[] = [];
  const pattern =
    /^\s*(?:import|export)\s(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/gmu;
  for (const match of text.matchAll(pattern)) {
    found.push(match[1]!);
  }
  return found;
};

/** A source without its comments, where a page may be spoken of. */
const code = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/^\s*\/\/.*$/gmu, "");

const resolve = (from: string, specifier: string): string => {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }
  const path = parts.join("/");
  for (const candidate of [`${path}.ts`, `${path}/index.ts`]) {
    if (candidate in sources) {
      return candidate;
    }
  }
  throw new Error(`${from} imports ${specifier}, which is not a source file`);
};

/** Every file an entry reaches, and every package it imports. */
const reach = (
  entry: string
): { readonly files: string[]; readonly packages: string[] } => {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) {
      return;
    }
    files.add(file);
    for (const specifier of imported(sources[file]!)) {
      if (specifier.startsWith(".")) {
        visit(resolve(file, specifier));
      } else {
        packages.add(specifier);
      }
    }
  };
  visit(entry);
  return {
    files: Array.from(files).toSorted(),
    packages: Array.from(packages).toSorted(),
  };
};

const sourceOf = (subpath: string): string =>
  `../${manifest.exports[subpath]!.source.slice("./".length)}`;

describe("the package's entries", () => {
  it("are arcadekit, arcadekit/Browser and arcadekit/ecs, each with a source file", () => {
    expect(Object.keys(manifest.exports).toSorted()).toEqual([
      ".",
      "./Browser",
      "./ecs",
    ]);
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      // Built under the name it is imported by: a module's as its namespace.
      const name = subpath === "." ? "index" : subpath.slice("./".length);
      expect(target.types, subpath).toBe(`./dist/${name}.d.ts`);
      expect(target.default, subpath).toBe(`./dist/${name}.js`);
      expect(sourceOf(subpath) in sources, subpath).toBe(true);
    }
    expect(sourceOf(".")).toBe("../src/index.ts");
    expect(sourceOf("./Browser")).toBe("../src/Browser.ts");
    expect(sourceOf("./ecs")).toBe("../src/ecs/index.ts");
  });

  it("arcadekit/ecs is the storage core alone: it imports no package, and nothing outside src/ecs", () => {
    const { files, packages } = reach(sourceOf("./ecs"));
    expect(packages).toEqual([]);
    expect(files.filter((file) => !file.startsWith("../src/ecs/"))).toEqual([]);
    // All of the storage core is behind it.
    expect(files).toEqual(
      Object.keys(sources)
        .filter((file) => file.startsWith("../src/ecs/"))
        .toSorted()
    );
  });

  it("arcadekit imports Effect and nothing else, and reaches nothing that only a page has", () => {
    const { files, packages } = reach(sourceOf("."));
    expect(
      packages.filter(
        (name) => name !== "effect" && !name.startsWith("effect/")
      )
    ).toEqual([]);
    expect(files).not.toContain("../src/Browser.ts");
    // Nor does any of it name what a page has and Node does not.
    const page =
      /\b(?:requestAnimationFrame|cancelAnimationFrame|createImageBitmap|navigator|document|window|addEventListener)\b/u;
    expect(files.filter((file) => page.test(code(sources[file]!)))).toEqual([]);
  });

  it("arcadekit/Browser is the one entry that imports a browser package, which is an optional peer", () => {
    const { files, packages } = reach(sourceOf("./Browser"));
    expect(
      packages.filter(
        (name) => name !== "effect" && !name.startsWith("effect/")
      )
    ).toEqual(["@effect/platform-browser/BrowserRuntime"]);
    expect(files).toContain("../src/Browser.ts");
    expect(manifest.peerDependencies["@effect/platform-browser"]).toBeDefined();
    expect(
      manifest.peerDependenciesMeta["@effect/platform-browser"]?.optional
    ).toBe(true);
    // Only its own file is its own: the rest is the game's, shared.
    const main = reach(sourceOf(".")).files;
    expect(files.filter((file) => !main.includes(file))).toEqual([
      "../src/Browser.ts",
    ]);
    // Every source file belongs to an entry.
    expect(
      Object.keys(sources)
        .filter((file) => !main.includes(file) && !files.includes(file))
        .toSorted()
    ).toEqual(["../src/ecs/index.ts"]);
  });
});

describe("arcadekit/ecs", () => {
  const Position = Ecs.Component.define("en/Position", {
    x: Ecs.Field.f32,
    y: Ecs.Field.f32,
  });
  const Tired = Ecs.Component.tag("en/Tired", { storage: "sparse" });
  const moving: Ecs.QuerySpec<readonly [typeof Position]> = {
    terms: [Position],
    withDefs: [],
    withoutDefs: [Tired],
  };

  it("is a world to spawn into, query, change through commands, hash and save, with no Effect", () => {
    const world = new Ecs.World({ seed: 7 });
    const first = world.spawn(Position.of({ x: 1, y: 2 }));
    const second = world.spawn(Position.of({ x: 3, y: 4 }), Tired);
    expect(Ecs.entityIndex(second)).toBe(1);
    expect(Ecs.entityGeneration(second)).toBe(0);
    const view = world.view(moving);
    expect(view).toBeInstanceOf(Ecs.QueryView);
    view.each((position) => {
      position.x += 10;
    });
    expect(world.get(first, Position)).toEqual({ x: 11, y: 2 });
    expect(world.get(second, Position)).toEqual({ x: 3, y: 4 });

    const commands = new Ecs.CommandBuffer(world);
    commands.remove(second, Tired);
    commands.despawn(first);
    commands.apply();
    expect(world.view(moving).entities()).toEqual([second]);

    const bytes = world.snapshot();
    const copy = new Ecs.World();
    copy.load(bytes, [Position, Tired]);
    expect(copy.hash()).toBe(world.hash());
    // A snapshot names what is stored: nobody is tired any more.
    expect(Ecs.readSnapshot(bytes).components.map((one) => one.name)).toEqual([
      "en/Position",
    ]);
    expect(() => copy.load(bytes, [Position, Tired])).toThrow(
      Ecs.SnapshotError
    );
    // Seeded, as in an app.
    expect(new Ecs.Rng(7).next()).toBe(
      new Ecs.World({ seed: 7 }).random.next()
    );
  });

  it("is the same storage core that arcadekit is built on, not a copy of it", () => {
    expect(Ecs.World).toBe(Main.EcsWorld);
    expect(Ecs.Component).toBe(Main.Component);
    expect(Ecs.CommandBuffer).toBe(Main.CommandBuffer);
    expect(Ecs.SnapshotError).toBe(Main.SnapshotError);
    expect(Ecs.readSnapshot).toBe(Main.readSnapshot);
    expect(Ecs.Field.f32).toBe(Main.Field.f32);
  });
});
