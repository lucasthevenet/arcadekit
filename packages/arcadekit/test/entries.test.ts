import { describe, expect, it } from "vitest";

import * as Ecs from "../src/ecs/index";
import * as Main from "../src/index";

// Vite gives a test the text of files, and the modules themselves: the
// sources of the package, and its manifest. Declared here, since the tests
// are compiled with no types but their own.
declare global {
  interface ImportMeta {
    readonly glob: {
      (
        pattern: string,
        options: {
          readonly query: "?raw";
          readonly import: "default";
          readonly eager: true;
        }
      ): Record<string, string>;
      (
        pattern: string,
        options: { readonly eager: true }
      ): Record<string, Record<string, unknown>>;
    };
  }
}

const sources = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const modules = import.meta.glob("../src/*.ts", { eager: true });
interface Target {
  readonly source: string;
  readonly types: string;
  readonly default: string;
}
const manifest = JSON.parse(
  Object.values(
    import.meta.glob("../package.json", {
      query: "?raw",
      import: "default",
      eager: true,
    })
  )[0]!
) as {
  readonly exports: Record<string, Target>;
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
const isEffect = (name: string): boolean =>
  name === "effect" || name.startsWith("effect/");
/** An entry of what only a page can use: the browser part of its area. */
const isBrowser = (subpath: string): boolean => subpath.endsWith("/Browser");
const entries = Object.keys(manifest.exports);
// What a page has and Node does not.
const page =
  /\b(?:requestAnimationFrame|cancelAnimationFrame|createImageBitmap|navigator|document|window|addEventListener)\b/u;

describe("the package's entries", () => {
  it("are the package itself, every module, the browser part of an area that has one, and the storage core", () => {
    // What the sources say the entries are: a module's is named as its
    // file is, and so is the browser part of its area.
    const expected: Record<string, Target> = {};
    const entry = (name: string, source: string): void => {
      const built = name === "." ? "index" : name.slice("./".length);
      expected[name] = {
        source: `./${source.slice("../".length)}`,
        types: `./dist/${built}.d.ts`,
        default: `./dist/${built}.js`,
      };
    };
    entry(".", "../src/index.ts");
    entry("./ecs", "../src/ecs/index.ts");
    for (const file of Object.keys(sources)) {
      const module = /^\.\.\/src\/([A-Z]\w*)\.ts$/u.exec(file);
      if (module !== null) {
        entry(`./${module[1]}`, file);
      }
      const browser = /^\.\.\/src\/([A-Z]\w*)\/Browser\.ts$/u.exec(file);
      if (browser !== null) {
        entry(`./${browser[1]}/Browser`, file);
      }
    }
    expect(manifest.exports).toEqual(expected);
    // In order, the package first, so that the list reads.
    expect(entries).toEqual([".", ...entries.slice(1).toSorted()]);
    // A few by name, so that this test does not only agree with itself.
    expect(entries).toContain("./App");
    expect(entries).toContain("./Input");
    expect(entries).toContain("./TickScheduler");
    expect(entries.filter((name) => isBrowser(name))).toEqual([
      "./App/Browser",
      "./Assets/Browser",
      "./Driver/Browser",
      "./Input/Browser",
    ]);
    expect(entries.length).toBe(24);
    // Every source file is behind some entry.
    const reached = new Set(
      entries.flatMap((name) => reach(sourceOf(name)).files)
    );
    expect(Object.keys(sources).filter((file) => !reached.has(file))).toEqual(
      []
    );
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

  it("no entry but a browser one imports anything but Effect, or reaches what only a page has", () => {
    for (const name of entries.filter((one) => !isBrowser(one))) {
      const { files, packages } = reach(sourceOf(name));
      expect(
        packages.filter((one) => !isEffect(one)),
        name
      ).toEqual([]);
      expect(
        files.filter((file) => file.endsWith("/Browser.ts")),
        name
      ).toEqual([]);
      // Nor does any of it name what a page has and Node does not.
      expect(
        files.filter((file) => page.test(code(sources[file]!))),
        name
      ).toEqual([]);
    }
    // The package's own entry is all of them but the browser ones.
    const main = reach(sourceOf(".")).files;
    expect(
      Object.keys(sources)
        .filter((file) => !main.includes(file))
        .toSorted()
    ).toEqual([
      "../src/App/Browser.ts",
      "../src/Assets/Browser.ts",
      "../src/Driver/Browser.ts",
      "../src/Input/Browser.ts",
      "../src/ecs/index.ts",
    ]);
  });

  it("a browser entry is the browser part of its own area, and one of them imports the browser package", () => {
    const importing: string[] = [];
    for (const name of entries.filter((one) => isBrowser(one))) {
      const { packages } = reach(sourceOf(name));
      const others = packages.filter((one) => !isEffect(one));
      if (others.length > 0) {
        importing.push(name);
        expect(others, name).toEqual([
          "@effect/platform-browser/BrowserRuntime",
        ]);
      }
      // It is where its area meets the page, by naming what a page has or
      // by importing the package that does: that is what it is for.
      expect(
        page.test(code(sources[sourceOf(name)]!)) || others.length > 0,
        name
      ).toBe(true);
    }
    // Starting a game in a page is what needs the platform's runMain.
    expect(importing).toEqual(["./App/Browser"]);
    expect(manifest.peerDependencies["@effect/platform-browser"]).toBeDefined();
    expect(
      manifest.peerDependenciesMeta["@effect/platform-browser"]?.optional
    ).toBe(true);
    // Each is its own area's and no other's. Starting a game in a page is
    // the one that brings two of them together: its display and devices.
    const browserFiles = (name: string): string[] =>
      reach(sourceOf(name)).files.filter((file) =>
        file.endsWith("/Browser.ts")
      );
    expect(browserFiles("./Input/Browser")).toEqual([
      "../src/Input/Browser.ts",
    ]);
    expect(browserFiles("./Driver/Browser")).toEqual([
      "../src/Driver/Browser.ts",
    ]);
    expect(browserFiles("./Assets/Browser")).toEqual([
      "../src/Assets/Browser.ts",
    ]);
    expect(browserFiles("./App/Browser")).toEqual([
      "../src/App/Browser.ts",
      "../src/Driver/Browser.ts",
      "../src/Input/Browser.ts",
    ]);
  });

  it("the package's own entry gives every module as its entry does: the same module, not a copy", () => {
    const main = Main as Record<string, unknown>;
    const namespaces = [
      "Action",
      "App",
      "Assets",
      "Driver",
      "Event",
      "Field",
      "Input",
      "Migrate",
      "Plugin",
      "Query",
      "Resource",
      "Save",
      "Singleton",
      "State",
      "System",
    ];
    for (const name of namespaces) {
      expect(main[name], name).toBe(modules[`../src/${name}.ts`]);
    }
    // The three it gives the names of, in place of the module.
    expect(Main.EntityId).toBe(modules["../src/Schemas.ts"]!.EntityId);
    expect(Main.Time).toBe(modules["../src/Services.ts"]!.Time);
    expect(Main.World).toBe(modules["../src/Services.ts"]!.World);
    expect(Main.TickScheduler).toBe(
      modules["../src/TickScheduler.ts"]!.TickScheduler
    );
    // Every module is one or the other.
    expect(
      Object.keys(modules)
        .map((file) => file.slice("../src/".length, -".ts".length))
        .filter((name) => name !== "index" && !namespaces.includes(name))
        .toSorted()
    ).toEqual(["Schemas", "Services", "TickScheduler"]);
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
