import { describe, expect, it } from "vitest";

import { packageCategory, renderIndex, renderPackage } from "./reference.ts";
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
});
