import * as Arcadekit from "arcadekit";
import { describe, expect, it } from "vitest";

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
  readonly dependencies?: Record<string, string>;
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

/** The source file a relative specifier leads to, from a file. */
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
/** The package a specifier names: "arcadekit/ecs" is of "arcadekit". */
const packageOf = (specifier: string): string =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

describe("the entries of @arcadekit/three", () => {
  it("are the package itself and every module", () => {
    const expected: Record<string, Target> = {
      ".": {
        source: "./src/index.ts",
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    };
    for (const file of Object.keys(sources)) {
      // A module is PascalCase, as it is imported, wherever its file is.
      // What the modules keep to themselves is in src/internals/,
      // kebab-case, and no entry.
      const module = /^\.\.\/src\/((?:\w+\/)*[A-Z]\w*)\.ts$/u.exec(file);
      if (module !== null) {
        expected[`./${module[1]}`] = {
          source: `./src/${module[1]}.ts`,
          types: `./dist/${module[1]}.d.ts`,
          default: `./dist/${module[1]}.js`,
        };
      }
    }
    expect(manifest.exports).toEqual(expected);
    expect(Object.keys(manifest.exports)).toEqual([
      ".",
      "./Assets",
      "./Gltf",
      "./Instances",
      "./Objects",
      "./Renderer",
      "./Scene",
      "./Three",
    ]);
    // Nothing in internals/ is named as a module is.
    expect(
      Object.keys(sources).filter((file) =>
        /\/internals\/(?:[\w-]+\/)*[A-Z][\w-]*\.ts$/u.test(file)
      )
    ).toEqual([]);
    // Every source file is behind some entry.
    const reached = new Set(
      Object.keys(manifest.exports).flatMap(
        (name) => reach(sourceOf(name)).files
      )
    );
    expect(Object.keys(sources).filter((file) => !reached.has(file))).toEqual(
      []
    );
  });

  it("has no components of its own: where a thing is drawn and in what colour are arcadekit's Transform3d and Color, which it imports by their entries", () => {
    const { packages } = reach(sourceOf("./Three"));
    expect(packages).toContain("arcadekit/Transform3d");
    expect(packages).toContain("arcadekit/Transform2d");
    expect(packages).toContain("arcadekit/Color");
    // It defines no component, in any of its files: it reads the game's.
    // (Its comments show a game defining one.)
    for (const file of reach(sourceOf("./Three")).files) {
      expect(
        sources[file]!.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(
          /^\s*\/\/.*$/gmu,
          ""
        ),
        file
      ).not.toMatch(/Component\.(?:define|tag|relation)\(/u);
    }
    expect(Object.keys(Main.Three)).not.toContain("Position");
  });

  it("imports arcadekit, Effect and Three.js, which a game has one of each: all three are peers, and nothing is a dependency", () => {
    // That it imports nothing else is the Oxlint rule
    // `arcadekit/entry-imports` (tooling/lint/plugin.ts).
    expect(
      reach(sourceOf("./Three")).packages.map((one) => packageOf(one))
    ).toContain("three");
    expect(manifest.dependencies).toBeUndefined();
    expect(Object.keys(manifest.peerDependencies).toSorted()).toEqual([
      "@types/three",
      "arcadekit",
      "effect",
      "three",
    ]);
    // Only the types are optional: a game written in JavaScript needs none.
    expect(manifest.peerDependenciesMeta).toEqual({
      "@types/three": { optional: true },
    });
  });

  it("the package's own entry gives each module as its entry does: the same module, not a copy", () => {
    const main = Main as Record<string, unknown>;
    expect(Object.keys(main).toSorted()).toEqual(["Gltf", "Three"]);
    expect(main.Three).toBe(modules["../src/Three.ts"]);
    expect(main.Gltf).toBe(modules["../src/Gltf.ts"]);
    // The loader of models comes with the module of models, and with no
    // other: a game that has none need not carry it.
    expect(reach(sourceOf("./Gltf")).packages).toContain(
      "three/addons/loaders/GLTFLoader.js"
    );
    expect(
      reach(sourceOf("./Three")).packages.filter((one) =>
        one.startsWith("three/")
      )
    ).toEqual([]);
  });

  it("gives from Three what each of its parts gives: the same values, so a game imports either", () => {
    const three = modules["../src/Three.ts"]!;
    const parts = Object.keys(manifest.exports).filter(
      (name) => ![".", "./Gltf", "./Three"].includes(name)
    );
    expect(parts.length).toBeGreaterThan(0);
    for (const name of parts) {
      const part = modules[sourceOf(name)]!;
      for (const [key, value] of Object.entries(part)) {
        expect(three[key], `${name}.${key}`).toBe(value);
      }
    }
  });

  it("is built on the game's own arcadekit, not on a copy of it", () => {
    // The components it draws from are the ones the game's world knows.
    const world = new Arcadekit.EcsWorld();
    const entity = world.spawn(
      Arcadekit.Transform3d.Position.of({ x: 1, y: 2, z: 3 })
    );
    expect(world.component("arcadekit/Transform3d.Position")).toBe(
      Arcadekit.Transform3d.Position
    );
    expect(world.get(entity, Arcadekit.Transform3d.Position)).toEqual({
      x: 1,
      y: 2,
      z: 3,
    });
    // After everything a frame draws, whatever order it is listed in.
    expect(Main.Three.Render.stage).toBe("postFrame");
  });
});
