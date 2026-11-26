import { describe, expect, it } from "@effect/vitest";
import { Context, Effect } from "effect";
import type { Layer } from "effect";

import * as Action from "../src/Action.ts";
import * as Assets from "../src/Assets.ts";
import * as BrowserEntry from "../src/browser/index.ts";
import * as Driver from "../src/Driver.ts";
import * as Ecs from "../src/ecs/index.ts";
import * as Main from "../src/index.ts";
import type { ReadingWorld, WritingWorld } from "../src/index.ts";
import * as Input from "../src/Input.ts";
import * as Net from "../src/net/index.ts";
import * as Transport from "../src/net/Transport.ts";
import * as Services from "../src/Services.ts";
import * as Sound from "../src/Sound.ts";
import * as System from "../src/System.ts";
import * as View from "../src/View.ts";

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
const netModules = import.meta.glob("../src/net/*.ts", { eager: true });
const browserModules = import.meta.glob("../src/browser/*.ts", {
  eager: true,
});
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
  if (path in sources) {
    return path;
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
  it("are the package itself, every module, the storage core, and the folder of what plays on several machines", () => {
    // What the sources say the entries are: a module's is named as its
    // file is, and built to the same path in dist/.
    const expected: Record<string, Target> = {};
    const entry = (name: string, source: string): void => {
      const built = source.slice("../src/".length, -".ts".length);
      expected[name] = {
        source: `./${source.slice("../".length)}`,
        types: `./dist/${built}.d.ts`,
        default: `./dist/${built}.js`,
      };
    };
    entry(".", "../src/index.ts");
    for (const file of Object.keys(sources)) {
      // A module is PascalCase, as it is imported, at its path, and a folder
      // is an entry by its index. Any other file, and any file of an
      // internal/ folder, is what a module keeps to itself, and no entry.
      if (file.includes("/internal/")) {
        continue;
      }
      const module = /^\.\.\/src\/((?:\w+\/)*[A-Z]\w*)\.ts$/u.exec(file);
      const folder = /^\.\.\/src\/((?:\w+\/)*\w+)\/index\.ts$/u.exec(file);
      const name = (module ?? folder)?.[1];
      if (name !== undefined) {
        entry(`./${name}`, file);
      }
    }
    expect(manifest.exports).toEqual(expected);
    // In order, the package first, so that the list reads.
    expect(entries).toEqual([".", ...entries.slice(1).toSorted()]);
    // A few by name, so that this test does not only agree with itself.
    expect(entries).toContain("./App");
    expect(entries).toContain("./Input");
    expect(entries).toContain("./browser");
    expect(entries).toContain("./browser/Browser");
    expect(entries).toContain("./browser/Audio");
    expect(entries).toContain("./net");
    expect(entries).toContain("./net/Session");
    expect(entries).toContain("./ecs");
    expect(entries.length).toBe(41);
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
  // arcadekit/browser's imports anything but Effect, reaches their files or
  // names what only a page has, and no source makes code from text.

  it("arcadekit/ecs is all of the storage core", () => {
    expect(reach(sourceOf("./ecs")).files).toEqual(
      Object.keys(sources)
        .filter((file) => file.startsWith("../src/ecs/"))
        .toSorted()
    );
  });

  // What only a page can use: arcadekit/browser's folder, internal/ with
  // it, and no other entry's.
  const browserFiles = Object.keys(sources)
    .filter((file) => file.startsWith("../src/browser/"))
    .toSorted();

  it("the package's own entry reaches every source but arcadekit/browser's, the storage core's index and src/net", () => {
    const main = reach(sourceOf(".")).files;
    expect(
      Object.keys(sources)
        .filter((file) => !main.includes(file))
        .toSorted()
    ).toEqual([
      ...browserFiles,
      "../src/ecs/index.ts",
      ...Object.keys(sources)
        .filter((file) => file.startsWith("../src/net/"))
        .toSorted(),
    ]);
    // A game with one player loads none of what several play with.
    expect(Object.keys(netModules).toSorted()).toEqual([
      "../src/net/Drift.ts",
      "../src/net/Message.ts",
      "../src/net/Relay.ts",
      "../src/net/Session.ts",
      "../src/net/Transport.ts",
      "../src/net/index.ts",
    ]);
  });

  it("arcadekit/browser is the one entry that imports a browser package, which is an optional peer", () => {
    const { files, packages } = reach(sourceOf("./browser"));
    expect(packages.filter((one) => !isEffect(one))).toEqual([
      "@effect/platform-browser/BrowserRuntime",
    ]);
    expect(manifest.peerDependencies["@effect/platform-browser"]).toBeDefined();
    expect(
      manifest.peerDependenciesMeta["@effect/platform-browser"]?.optional
    ).toBe(true);
    // Only its own files are its own: the rest is the game's, shared.
    expect(browserFiles).toContain("../src/browser/Browser.ts");
    expect(browserFiles).toContain("../src/browser/internal/audio.ts");
    const main = reach(sourceOf(".")).files;
    expect(files.filter((file) => !main.includes(file)).toSorted()).toEqual(
      browserFiles
    );
  });

  it("the package's own entry gives every module as its entry does: the same module, not a copy", () => {
    const main = Main as Record<string, unknown>;
    const namespaces = [
      "Action",
      "App",
      "Assets",
      "Color",
      "Component",
      "Driver",
      "Event",
      "Field",
      "Grid",
      "Input",
      "Journal",
      "Migrate",
      "Overlap",
      "Plugin",
      "Query",
      "Resource",
      "Save",
      "Singleton",
      "Sound",
      "State",
      "System",
      "Test",
      "Timeline",
      "Timer",
      "Transform2d",
      "Transform3d",
      "Vec2",
      "View",
    ];
    for (const name of namespaces) {
      expect(main[name], name).toBe(modules[`../src/${name}.ts`]);
    }
    // The two it gives the names of, in place of the module.
    expect(Main.EntityId).toBe(modules["../src/Schemas.ts"]!.EntityId);
    expect(Main.Time).toBe(modules["../src/Services.ts"]!.Time);
    expect(Main.World).toBe(modules["../src/Services.ts"]!.World);
    // Every module of src/ is one or the other. What only a page can use
    // is in src/browser/, which the package's own entry leaves out.
    expect(
      Object.keys(modules)
        .map((file) => file.slice("../src/".length, -".ts".length))
        .filter((name) => name !== "index" && !namespaces.includes(name))
        .toSorted()
    ).toEqual(["Schemas", "Services"]);
    expect("Browser" in main).toBe(false);
    expect("browser" in main).toBe(false);
  });
});

describe("arcadekit/net", () => {
  it("gives every module of its folder as the module's own entry does, and the package's own entry none of them", () => {
    const net = Net as Record<string, unknown>;
    const names = ["Drift", "Message", "Relay", "Session", "Transport"];
    for (const name of names) {
      expect(net[name], name).toBe(netModules[`../src/net/${name}.ts`]);
      expect(name in (Main as Record<string, unknown>), name).toBe(false);
      expect(sourceOf(`./net/${name}`)).toBe(`../src/net/${name}.ts`);
    }
    expect(Object.keys(net).toSorted()).toEqual(names);
  });

  it("passes messages on without a session: a relay reaches no app, no peer and no session", () => {
    const built = ["../src/internal/build.ts", "../src/App.ts"];
    for (const entry of ["./net/Message", "./net/Relay"]) {
      const { files } = reach(sourceOf(entry));
      expect(
        files.filter((file) => built.includes(file)),
        entry
      ).toEqual([]);
      // Nor the session, the peer or what finds they have drifted apart.
      expect(
        files.filter((file) => /net\/(?:Session|Peer|Drift)\.ts$/u.test(file)),
        entry
      ).toEqual([]);
    }
  });
});

describe("arcadekit/browser", () => {
  it("gives every module of its folder as the module's own entry does, and the package's own entry none of them", () => {
    const browser = BrowserEntry as Record<string, unknown>;
    const names = ["Audio", "Browser"];
    for (const name of names) {
      expect(browser[name], name).toBe(
        browserModules[`../src/browser/${name}.ts`]
      );
      expect(name in (Main as Record<string, unknown>), name).toBe(false);
      expect(sourceOf(`./browser/${name}`)).toBe(`../src/browser/${name}.ts`);
    }
    expect(Object.keys(browser).toSorted()).toEqual(names);
  });
});

describe("arcadekit/ecs", () => {
  const Position = Ecs.Component.define("en/Position", {
    x: Ecs.Field.f32,
    y: Ecs.Field.f32,
  });
  const Tired = Ecs.Component.tag("en/Tired", { storage: "sparse" });
  const moving = Main.Query.all(Position).pipe(
    Main.Query.without(Tired),
    Main.Query.writes(Position)
  );

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
    expect(Ecs.Component.define).toBe(Main.Component.define);
    expect(Ecs.Component.relation).toBe(Main.Component.relation);
    expect(Ecs.Component.tag).toBe(Main.Component.tag);
    expect(Ecs.Field.f32).toBe(Main.Field.f32);
  });

  it("gives arcadekit none of its own values, so a game imports none of its classes, and defines a singleton one way", () => {
    const core = new Set<unknown>(Object.values(Ecs));
    const given = Object.entries(Main).filter(([, value]) => core.has(value));
    expect(given.map(([name]) => name)).toEqual([]);
    expect(Object.keys(Main.Component).toSorted()).toEqual([
      "define",
      "relation",
      "tag",
    ]);
    // The world's two types, which a helper that takes a world names.
    const reads = (world: ReadingWorld): number => world.entityCount;
    const writes = (world: WritingWorld<"en/Position">): number =>
      world.entityCount;
    expect([reads, writes]).toHaveLength(2);
  });
});

// What a program provides from outside an app, each with its module's
// `layer`, given the stand-in its module makes for a test. A new service
// joins this list, or `byTheApp` when an app or a plugin provides it.
const providing = <I, S>(
  service: Context.Key<I, S>,
  layer: Layer.Layer<I>
): {
  readonly service: unknown;
  readonly key: string;
  readonly given: Effect.Effect<S>;
  /** What the service is where nothing provides it, if anything. */
  readonly fallback: S | undefined;
} => ({
  service,
  key: service.key,
  given: Effect.provide(Effect.service(service), layer),
  fallback: Context.isReference(service) ? service.defaultValue() : undefined,
});
const provided = [
  providing(Input.Source, Input.layer(Input.makeManualSource())),
  providing(Sound.Output, Sound.layer(Sound.makeRecorder())),
  providing(Driver.Display, Driver.layer(Driver.makeManualDisplay())),
  providing(Assets.Loader, Assets.layer(Assets.makeMemory({}))),
  providing(
    Transport.Transport,
    Transport.layer(Transport.makeHub().port("ada"))
  ),
];
const byTheApp: readonly unknown[] = [
  Services.Sim,
  Services.World,
  Services.Time,
  Services.Frame,
  Services.Commands,
  Services.Events,
  Services.Random,
  Action.Actions,
  Input.Devices,
  Input.Keyboard,
  Input.Pointer,
  Input.Gamepads,
  Sound.Player,
  Assets.Store,
  View.Port,
  System.Locals,
];

/** Every module an entry gives by its own name, as `arcadekit/Input`, and what it exports. */
const named = Object.keys(manifest.exports)
  .filter((subpath) => /\/[A-Z]\w*$/u.test(subpath))
  .map((subpath) => ({
    entry: `arcadekit${subpath.slice(1)}`,
    exports: Object.entries(
      { ...modules, ...netModules, ...browserModules }[sourceOf(subpath)]!
    ),
  }));

describe("a service", () => {
  it("is keyed by the entry it is imported from and its name there", () => {
    const keys = named.flatMap(({ entry, exports }) =>
      exports.flatMap(([name, value]) =>
        Context.isKey(value) ? [[`${entry}.${name}`, value.key]] : []
      )
    );
    expect(keys.length).toBe(provided.length + byTheApp.length);
    for (const [wanted, key] of keys) {
      expect(key, wanted).toBe(wanted);
    }
  });

  it("is provided by its module's layer given its stand-in, or by the app itself", () => {
    const listed = new Set<unknown>([
      ...provided.map(({ service }) => service),
      ...byTheApp,
    ]);
    const services = named.flatMap(({ entry, exports }) =>
      exports.flatMap(([name, value]) =>
        Context.isKey(value) ? [{ name: `${entry}.${name}`, value }] : []
      )
    );
    const unlisted = services
      .filter(({ value }) => !listed.has(value))
      .map(({ name }) => name);
    expect(
      unlisted,
      "A service a program provides has a layer, X.layer(implementation), and a stand-in, X.make...(): add it to `provided` with both, or to `byTheApp` if the app or a plugin provides it."
    ).toEqual([]);
  });

  it.effect(
    "a program provides is given by its module's layer, in place of its default",
    () =>
      Effect.gen(function* () {
        for (const { fallback, given, key } of provided) {
          const value: unknown = yield* given;
          expect(value, key).toBeDefined();
          expect(value, key).not.toBe(fallback);
        }
      })
  );
});
