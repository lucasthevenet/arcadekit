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
const entries = Object.keys(manifest.exports);

describe("the package's entries", () => {
  it("are the package itself, every module, and the storage core", () => {
    // What the sources say the entries are: a module's is named as its
    // file is.
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
    }
    expect(manifest.exports).toEqual(expected);
    // In order, the package first, so that the list reads.
    expect(entries).toEqual([".", ...entries.slice(1).toSorted()]);
    // A few by name, so that this test does not only agree with itself.
    expect(entries).toContain("./App");
    expect(entries).toContain("./Input");
    expect(entries).toContain("./TickScheduler");
    expect(entries).toContain("./Browser");
    expect(entries.length).toBe(34);
    // No module is in a folder of its own: one file, one entry.
    expect(
      Object.keys(sources).filter(
        (file) =>
          !/^\.\.\/src\/\w+\.ts$/u.test(file) && !file.startsWith("../src/ecs/")
      )
    ).toEqual([]);
    // Every source file is behind some entry.
    const reached = new Set(
      entries.flatMap((name) => reach(sourceOf(name)).files)
    );
    expect(Object.keys(sources).filter((file) => !reached.has(file))).toEqual(
      []
    );
  });

  // What a source may import or name, by the entry it is behind, is held by
  // the Oxlint rules of tooling/lint/plugin.ts, file by file: arcadekit/ecs
  // imports no package and nothing outside src/ecs, no entry but
  // arcadekit/Browser imports anything but Effect, reaches src/Browser.ts or
  // names what only a page has, and no source makes code from text.

  it("arcadekit/ecs is all of the storage core", () => {
    expect(reach(sourceOf("./ecs")).files).toEqual(
      Object.keys(sources)
        .filter((file) => file.startsWith("../src/ecs/"))
        .toSorted()
    );
  });

  it("the package's own entry reaches every source but src/Browser.ts and the storage core's index", () => {
    const main = reach(sourceOf(".")).files;
    expect(
      Object.keys(sources)
        .filter((file) => !main.includes(file))
        .toSorted()
    ).toEqual(["../src/Browser.ts", "../src/ecs/index.ts"]);
  });

  it("arcadekit/Browser is the one entry that imports a browser package, which is an optional peer", () => {
    const { files, packages } = reach(sourceOf("./Browser"));
    expect(packages.filter((one) => !isEffect(one))).toEqual([
      "@effect/platform-browser/BrowserRuntime",
    ]);
    expect(manifest.peerDependencies["@effect/platform-browser"]).toBeDefined();
    expect(
      manifest.peerDependenciesMeta["@effect/platform-browser"]?.optional
    ).toBe(true);
    // Only its own file is its own: the rest is the game's, shared.
    const main = reach(sourceOf(".")).files;
    expect(files.filter((file) => !main.includes(file))).toEqual([
      "../src/Browser.ts",
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
      "Journal",
      "Lockstep",
      "Migrate",
      "Outbox",
      "Plugin",
      "Query",
      "Relay",
      "Resource",
      "Rollback",
      "Runner",
      "Save",
      "Schedule",
      "Singleton",
      "Sound",
      "State",
      "System",
      "Timeline",
      "Transform2d",
      "Transform3d",
      "Transport",
      "View",
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
    // Every module is one or the other, but for the one that only a page
    // can use, which the package's own entry leaves out.
    expect(
      Object.keys(modules)
        .map((file) => file.slice("../src/".length, -".ts".length))
        .filter((name) => name !== "index" && !namespaces.includes(name))
        .toSorted()
    ).toEqual(["Browser", "Schemas", "Services", "TickScheduler"]);
    expect("Browser" in main).toBe(false);
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
