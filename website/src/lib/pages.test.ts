import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { discoverPages, firstParagraph } from "./pages.ts";
import type { DocPage, SitePages } from "./pages.ts";
import { MODULE_GROUPS, moduleGroups } from "./reference.ts";
import { outlinedGroups, sidebarTopics } from "./sidebar.ts";
import { REPO_ROOT } from "./site.ts";

const doc = (slug: string): DocPage => ({
  file: `website/src/content/docs/${slug}.md`,
  slug,
  link: `/${slug}`,
  section: slug.includes("/") ? (slug.split("/", 1)[0] ?? "") : "",
});

/** The site's pages, with some of its docs added or taken out. */
const withDocs = (pages: SitePages, docs: readonly DocPage[]): SitePages => ({
  ...pages,
  docs,
});

/** Each group's label, with the pages it lists. */
const labelled = (groups: ReturnType<typeof outlinedGroups>) =>
  Object.fromEntries(groups.map((group) => [group.label, group.items]));

describe("the site's pages", () => {
  const pages = discoverPages();

  it("has a page for each file under src/content/docs/, at its path there", () => {
    const own = pages.docs;
    const links = own.map((page) => page.link);
    expect(links).toContain("/making-a-game");
    expect(links).toContain("/guides/input");
    expect(links).toContain("/concepts/determinism");
    for (const page of own) {
      expect(page.file).toBe(`website/src/content/docs/${page.slug}.md`);
      expect(page.link).toBe(`/${page.slug}`);
    }
  });

  it("has the reference's index at /reference, and each package's page at /reference/<its folder>, from its package.json", () => {
    expect(pages.reference.link).toBe("/reference");
    expect(pages.packages.map((page) => [page.file, page.link])).toStrictEqual([
      ["packages/arcadekit/package.json", "/reference/arcadekit"],
      ["packages/three/package.json", "/reference/three"],
    ]);
    expect(pages.packages.map((page) => page.title)).toStrictEqual([
      "arcadekit",
      "@arcadekit/three",
    ]);
    expect(pages.packages[1]?.modules).toStrictEqual(["Gltf", "Three"]);
  });

  it("has no page that mentions the roadmap, which is the repository's and not the docs'", () => {
    const own = readdirSync(path.join(REPO_ROOT, "website/src/content/docs"), {
      recursive: true,
    })
      .map(String)
      .filter((file) => /\.mdx?$/u.test(file));
    for (const file of own) {
      const text = readFileSync(
        path.join(REPO_ROOT, "website/src/content/docs", file),
        "utf-8"
      );
      expect(text, file).not.toMatch(/roadmap/iu);
    }
    expect(pages.all.map((page) => page.file)).not.toContain("ROADMAP.md");
  });

  it("names files that exist, each served at an address of its own", () => {
    for (const page of pages.all) {
      expect(existsSync(path.join(REPO_ROOT, page.file))).toBe(true);
    }
    const links = pages.all.map((page) => page.link);
    expect(new Set(links).size).toBe(links.length);
  });
});

describe("the sidebar", () => {
  it("lists a page the outline doesn't name at the end of its folder's group", () => {
    const pages = discoverPages();
    const groups = labelled(
      outlinedGroups(
        withDocs(pages, [
          ...pages.docs,
          doc("concepts/physics"),
          doc("guides/menus"),
          doc("changelog"),
          doc("recipes/menus"),
        ])
      )
    );
    expect(groups.Concepts?.at(-1)).toBe("concepts/physics");
    expect(groups.More).toStrictEqual(["guides/menus"]);
    // A file directly in src/content/docs/, or in a folder no group has, goes in Get started.
    expect(groups["Get started"]?.slice(-2)).toStrictEqual([
      "changelog",
      "recipes/menus",
    ]);
  });

  it("leaves out a group with no page", () => {
    const groups = labelled(outlinedGroups(discoverPages()));
    expect(groups.More).toBeUndefined();
  });

  it("names only pages that exist", () => {
    const pages = discoverPages();
    const without = withDocs(
      pages,
      pages.docs.filter((page) => page.slug !== "guides/input")
    );
    expect(() => outlinedGroups(without)).toThrow("guides/input");
  });

  it("has a topic for learning, one for the guides and one for the reference", () => {
    const pages = discoverPages();
    const topics = sidebarTopics(pages);
    expect(topics.map((topic) => topic.label)).toStrictEqual([
      "Learn",
      "Guides",
      "Reference",
    ]);
    // Every page is in a topic.
    const listed = JSON.stringify(topics);
    for (const page of [...pages.docs, ...pages.modules]) {
      expect(listed).toContain(`"${page.slug}"`);
    }
    for (const page of [pages.reference, ...pages.packages]) {
      expect(listed).toContain(`"${page.link}"`);
    }
  });

  it("lists each package with its page and its modules in Reference", () => {
    const groups = outlinedGroups(discoverPages()).filter(
      (group) => group.topic === "reference"
    );
    expect(groups.map((group) => group.label)).toStrictEqual([
      "arcadekit",
      "@arcadekit/three",
    ]);
    expect(groups[0]?.items.slice(0, 3)).toStrictEqual([
      { label: "Overview", link: "/reference/arcadekit" },
      {
        label: "Core",
        items: expect.arrayContaining([
          "reference/arcadekit/App",
          "reference/arcadekit/System",
        ]),
      },
      { label: "Storage", items: ["reference/arcadekit/ecs"] },
    ]);
    expect(groups[1]?.items).toStrictEqual([
      { label: "Overview", link: "/reference/three" },
      "reference/three/Gltf",
      "reference/three/Three",
    ]);
  });

  it("lists every module of a package with groups under one of them", () => {
    for (const page of discoverPages().packages) {
      if (MODULE_GROUPS[page.folder] === undefined) {
        continue;
      }
      const labels = moduleGroups(page).map((group) => group.label);
      // A new module goes under a group in MODULE_GROUPS of src/lib/reference.ts.
      expect(labels, page.folder).not.toContain("Other");
    }
  });

  it("has a page for each module a package exports, but the package's own entry", () => {
    const modules = discoverPages().modules;
    expect(modules.map((page) => page.link)).toContain(
      "/reference/arcadekit/Sound"
    );
    expect(modules.map((page) => page.link)).not.toContain(
      "/reference/arcadekit/index"
    );
    expect(modules.find((page) => page.name === "Sound")?.file).toBe(
      "packages/arcadekit/src/Sound.ts"
    );
  });
});

describe("a page's description", () => {
  it("is its first paragraph as plain text", () => {
    expect(
      firstParagraph(
        "# arcadekit/thing\n\nLoads a [thing](https://example.com) with `loadThing`, **fast**.\n\n## Install\n"
      )
    ).toBe("Loads a thing with loadThing, fast.");
  });

  it("starts at a paragraph that opens with an issue number, not at a heading", () => {
    expect(
      firstParagraph(
        "# A page\n\n## Context\n\n#24 asked what a sound is.\n\n**The look.** Pixel art.\n"
      )
    ).toBe("#24 asked what a sound is.");
  });

  it("skips frontmatter, and stops at a sentence when the paragraph is long", () => {
    const long = `${"A first sentence that says what the page is for. ".repeat(4)}And one more that would make it too long to show under a shared link.`;
    expect(
      firstParagraph(`---\ntitle: A page\n---\n\n# A page\n\n${long}\n`)
    ).toBe(
      "A first sentence that says what the page is for. ".repeat(4).trim()
    );
  });
});
