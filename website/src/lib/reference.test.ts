import { describe, expect, it } from "vitest";

import {
  MODULE_GROUPS,
  moduleGroups,
  packageCategory,
  renderIndex,
  renderPackage,
} from "./reference.ts";
import type { ReferencePackage } from "./reference.ts";

const REPO_URL = "https://github.com/lucasthevenet/arcadekit";

const kit: ReferencePackage = {
  folder: "arcadekit",
  name: "arcadekit",
  description: "Games on Effect.",
  modules: ["App", "Query"],
};
const three: ReferencePackage = {
  folder: "three",
  name: "@arcadekit/three",
  description: "Draws a game with Three.js.",
  modules: ["Three"],
};
const physics: ReferencePackage = {
  folder: "physics",
  name: "@arcadekit/physics",
  description: "Bodies that collide.",
  modules: ["Body", "World"],
};

describe("the reference's index", () => {
  it("lists each package under its category, with how many modules it has and its description", () => {
    expect(renderIndex([three, kit])).toBe(
      [
        "## Core",
        "### [arcadekit](/reference/arcadekit)\n\n2 modules\n\nGames on Effect.",
        "## Rendering",
        "### [@arcadekit/three](/reference/three)\n\n1 module\n\nDraws a game with Three.js.",
      ].join("\n\n")
    );
  });

  it("lists a package no category names under Other, last", () => {
    expect(packageCategory("physics")).toBe("Other");
    expect(renderIndex([physics, kit]).split("\n\n").at(-4)).toBe("## Other");
  });
});

describe("a package's page", () => {
  it("gives its description, where it is published and written, and links each module", () => {
    expect(renderPackage(three, REPO_URL, "main")).toBe(
      [
        "Draws a game with Three.js.",
        `1 module · [npm](https://www.npmjs.com/package/@arcadekit/three) · [Source](${REPO_URL}/tree/main/packages/three)`,
        "## Modules",
        "- [Three](/reference/three/Three)",
      ].join("\n\n")
    );
  });

  it("lists the modules of a package with groups under each group, in the package's order", () => {
    const modules = (MODULE_GROUPS.arcadekit ?? [])
      .flatMap((group) => group.modules)
      .toReversed();
    const blocks = renderPackage({ ...kit, modules }, REPO_URL, "main").split(
      "\n\n"
    );
    expect(blocks.filter((block) => block.startsWith("#"))).toStrictEqual([
      "## Modules",
      "### Core",
      "### Storage",
      "### Browser",
      "### Media",
      "### Saves",
      "### Net",
    ]);
    expect(blocks.at(-3)).toBe(
      "- [Timeline](/reference/arcadekit/Timeline)\n- [Save](/reference/arcadekit/Save)\n- [Migrate](/reference/arcadekit/Migrate)\n- [Journal](/reference/arcadekit/Journal)"
    );
  });
});

describe("the groups of a package's modules", () => {
  const groups = MODULE_GROUPS.arcadekit ?? [];
  const every = groups.flatMap((group) => group.modules);

  it("names each module once", () => {
    expect(new Set(every).size).toBe(every.length);
  });

  it("lists a module no group names under Other, last", () => {
    expect(
      moduleGroups({ folder: "arcadekit", modules: [...every, "Physics"] }).at(
        -1
      )
    ).toStrictEqual({ label: "Other", modules: ["Physics"] });
  });

  it("refuses a group that names a module the package doesn't have", () => {
    expect(() =>
      moduleGroups({
        folder: "arcadekit",
        modules: every.filter((name) => name !== "Sound"),
      })
    ).toThrow("names Sound, which arcadekit doesn't export");
  });

  it("gives a package with no groups one list", () => {
    expect(moduleGroups(physics)).toStrictEqual([
      { modules: ["Body", "World"] },
    ]);
  });
});
