import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverPages,
  firstParagraph,
  kitEntries,
  splitTitle,
} from "./pages.ts";
import type { DocPage, EntryPage } from "./pages.ts";
import {
  orderedEntries,
  outlinedDocs,
  referenceGroups,
  sidebarTopics,
} from "./sidebar.ts";
import { REPO_ROOT } from "./site.ts";

const entry = (name: string): EntryPage => ({
  file: `packages/arcadekit/src/${name}/README.md`,
  files: [`packages/arcadekit/src/${name}/README.md`],
  slug: `reference/${name}`,
  link: `/reference/${name}`,
  title: `arcadekit/${name}`,
  description: "",
  body: "",
  entry: name,
  readme: true,
  exports: 0,
});

const doc = (slug: string): DocPage => ({
  file: `docs/${slug}.md`,
  files: [`docs/${slug}.md`],
  slug,
  link: `/${slug}`,
  title: slug,
  description: "",
  body: "",
  section: slug.includes("/") ? (slug.split("/", 1)[0] ?? "") : "",
});

describe("the site's pages", () => {
  const pages = discoverPages();

  it("has a page for each file under docs/, at its path there", () => {
    const links = pages.docs.map((page) => page.link);
    expect(links).toContain("/making-a-game");
    expect(links).toContain("/guides/sprites");
    expect(links).toContain("/concepts/determinism");
    for (const page of pages.docs) {
      expect(page.file).toBe(`docs/${page.slug}.md`);
      expect(page.link).toBe(`/${page.slug}`);
    }
  });

  it("has a reference page for each entry of the package, at its import path", () => {
    const links = pages.entries.map((page) => page.link);
    expect(links.toSorted()).toStrictEqual(
      Object.keys(kitEntries())
        .map((name) => `/reference/${name}`)
        .toSorted()
    );
    expect(links).toContain("/reference/net/worker");
  });

  // The site would build without these two, but the sidebar lists a page by its heading and a
  // shared link shows its first paragraph (website/README.md, "A new page").
  it("has READMEs that start with their import path as the heading, then a paragraph", () => {
    const readmes = pages.entries.filter((page) => page.readme);
    expect(readmes.map((page) => page.entry)).toContain("core");
    for (const page of readmes) {
      expect(page.file).toBe(`packages/arcadekit/src/${page.entry}/README.md`);
      expect(
        page.title,
        `${page.file} must start with the heading "# arcadekit/${page.entry}", its import path: the sidebar lists the page by it`
      ).toBe(`arcadekit/${page.entry}`);
      expect(
        page.description,
        `${page.file} must have a paragraph after its heading: it is the page's description`
      ).not.toBe("");
    }
  });

  it("gives an entry with no README its public file's comment, without its import path", () => {
    const browser = pages.entries.find((page) => page.entry === "net/browser");
    expect(browser?.readme).toBe(false);
    expect(browser?.file).toBe("packages/arcadekit/src/net/browser/index.ts");
    expect(browser?.description).toMatch(/^Lockstep over WebRTC/u);
    // Its modules, each with what it is, then its own exports.
    expect(browser?.body).toContain(
      "- [`CoopClient`](coop-client.ts): one player's side of a co-op game"
    );
    expect(browser?.body).toContain("## Declarations\n\n### Coop");
  });

  it("adds an entry's own exports to its README, and says which entry's it has too", () => {
    const game = pages.entries.find((page) => page.entry === "game");
    expect(game?.files).toStrictEqual([
      "packages/arcadekit/src/game/README.md",
      "packages/arcadekit/src/game/index.ts",
    ]);
    expect(game?.body).toContain("## API\n\n### Declarations\n\n#### Command");
    const browser = pages.entries.find((page) => page.entry === "game/browser");
    expect(browser?.body).toMatch(
      /^It has every export of \[`arcadekit\/game`\]\(README\.md\) too/mu
    );
    expect(browser?.body).toContain("### Engine");
    expect(browser?.body).not.toContain("### Simulation");
  });

  it("has a page for each module, at its file's name", () => {
    const rng = pages.modules.find(
      (page) => page.slug === "reference/core/rng"
    );
    expect(rng?.module).toBe("Rng");
    expect(rng?.file).toBe("packages/arcadekit/src/core/rng.ts");
    expect(rng?.body).toContain('import { Rng } from "arcadekit/core";');
    expect(rng?.body).toContain("## Constructors\n\n### make");
    expect(pages.modules.map((page) => page.slug)).toContain(
      "reference/net/browser/coop-client"
    );
  });

  it("has the package's README at /reference, the reference's first page", () => {
    expect(pages.kit.file).toBe("packages/arcadekit/README.md");
    expect(pages.kit.link).toBe("/reference");
    expect(pages.kit.title).toBe("arcadekit");
  });

  it("has the glossary", () => {
    expect(pages.glossary.file).toBe("CONTEXT.md");
    expect(pages.glossary.link).toBe("/glossary");
  });

  it("renders each file below its title, which Starlight writes", () => {
    for (const page of pages.repository) {
      expect(page.body).not.toMatch(/^# /u);
      expect(page.body.length).toBeGreaterThan(0);
    }
  });

  it("names files that exist, each served at an address of its own", () => {
    for (const page of pages.all) {
      expect(existsSync(path.join(REPO_ROOT, page.file))).toBe(true);
    }
    const links = pages.all.map((page) => page.link);
    expect(new Set(links).size).toBe(links.length);
  });
});

const labelled = (groups: { label: string; items: readonly unknown[] }[]) =>
  Object.fromEntries(groups.map((group) => [group.label, group.items]));

describe("the sidebar", () => {
  it("lists a page the outline doesn't name at the end of its folder's group", () => {
    const pages = discoverPages();
    const groups = labelled(
      outlinedDocs([
        ...pages.docs,
        doc("concepts/rollback"),
        doc("guides/menus"),
        doc("testing/replays"),
        doc("changelog"),
        doc("recipes/menus"),
      ])
    );
    expect(groups.Concepts?.at(-1)).toBe("concepts/rollback");
    expect(groups.More).toStrictEqual(["guides/menus"]);
    expect(groups.Testing?.at(-1)).toBe("testing/replays");
    // A file directly in docs/, or in a folder no group has, goes in Get started.
    expect(groups["Get started"]?.slice(-2)).toStrictEqual([
      "changelog",
      "recipes/menus",
    ]);
  });

  it("leaves out a group with no page", () => {
    const groups = labelled(outlinedDocs(discoverPages().docs));
    expect(groups.More).toBeUndefined();
  });

  it("names only pages that exist", () => {
    const pages = discoverPages();
    const without = pages.docs.filter((page) => page.slug !== "guides/sprites");
    expect(() => outlinedDocs(without)).toThrow("guides/sprites");
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
    for (const page of pages.repository) {
      expect(listed).toContain(`"${page.slug}"`);
    }
  });

  it("lists the entries by group, then any other, each with its sub-entries", () => {
    const ordered = orderedEntries(
      ["core", "game", "net", "net/worker", "physics", "net/browser"].map(entry)
    ).map((page) => page.entry);
    expect(ordered).toStrictEqual([
      "game",
      "core",
      "net",
      "net/browser",
      "net/worker",
      "physics",
    ]);
  });

  it("lists the package, each entry's page and modules in Reference, then the glossary", () => {
    const groups = referenceGroups(discoverPages());
    expect(groups[0]).toStrictEqual({
      label: "The package",
      slug: "reference",
    });
    expect(groups.at(-1)).toBe("glossary");
    const core = groups.find(
      (group) => typeof group === "object" && group.label === "arcadekit/core"
    );
    expect(core).toMatchObject({ collapsed: true });
    expect(
      typeof core === "object" && "items" in core ? core.items.slice(0, 2) : []
    ).toStrictEqual([
      { label: "Overview", slug: "reference/core" },
      "reference/core/entity-pool",
    ]);
    // A sub-entry with modules is a group of its own; one with none is its page.
    const game = groups.find(
      (group) => typeof group === "object" && group.label === "arcadekit/game"
    );
    expect(game).toMatchObject({
      items: [
        { label: "Overview", slug: "reference/game" },
        "reference/game/browser",
        "reference/game/scenario",
        {
          label: "arcadekit/game/testing",
          items: [
            { label: "Overview", slug: "reference/game/testing" },
            "reference/game/testing/manual-frames",
          ],
        },
      ],
    });
  });
});

describe("a page's title", () => {
  it("is the heading on its file's first line, which its body leaves out", () => {
    expect(
      splitTitle("# arcadekit/thing\n\nLoads a thing.\n", "thing.md")
    ).toStrictEqual({ title: "arcadekit/thing", body: "Loads a thing.\n" });
  });

  it("must be there", () => {
    expect(() => splitTitle("Loads a thing.\n\n# Later\n", "thing.md")).toThrow(
      'thing.md must start with a "# " heading'
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
