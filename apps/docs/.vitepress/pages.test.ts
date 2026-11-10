import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverPages,
  firstParagraph,
  markdownThatIsNotAPage,
  REPO_ROOT,
} from "./pages.ts";
import type { EntryPage } from "./pages.ts";
import { sidebar } from "./sidebar.ts";

describe("the site's pages", () => {
  const pages = discoverPages();

  it("has a page for each entry's README, at its import path", () => {
    const links = pages.entries.map((page) => page.link);
    expect(links).toContain("/core");
    expect(links).toContain("/net");
    expect(links).toContain("/net/worker");
    for (const page of pages.entries) {
      expect(page.file).toBe(`packages/arcadekit/src/${page.entry}/README.md`);
      expect(page.link).toBe(`/${page.entry}`);
      expect(page.title).toBe(`arcadekit/${page.entry}`);
      expect(page.description).not.toBe("");
    }
  });

  it("has the glossary and every decision", () => {
    expect(pages.glossary.file).toBe("CONTEXT.md");
    expect(pages.adrs.length).toBeGreaterThan(0);
    for (const adr of pages.adrs) {
      expect(adr.link).toBe(`/adr/${path.basename(adr.file, ".md")}`);
      expect(adr.title).not.toBe("");
      expect(adr.status).not.toBe("");
    }
  });

  it("names files that exist, each served at an address of its own", () => {
    for (const page of pages.all) {
      expect(existsSync(path.join(REPO_ROOT, page.file))).toBe(true);
    }
    const links = pages.all.map((page) => page.link);
    expect(new Set(links).size).toBe(links.length);
  });

  it("leaves every other markdown file of the repository out", () => {
    const left = markdownThatIsNotAPage(pages);
    for (const file of [
      "README.md",
      "AGENTS.md",
      "apps/survivor-demo/README.md",
      "packages/arcadekit/README.md",
      "packages/arcadekit/CHANGELOG.md",
    ]) {
      expect(left).toContain(file);
    }
    for (const page of pages.all) {
      expect(left).not.toContain(page.file);
    }
  });
});

const entry = (name: string): EntryPage => ({
  file: `packages/arcadekit/src/${name}/README.md`,
  servedAs: `${name}.md`,
  link: `/${name}`,
  description: "",
  entry: name,
  title: `arcadekit/${name}`,
});

describe("the sidebar", () => {
  it("lists an entry no group names, under its top folder's group or under More", () => {
    const groups = sidebar({
      ...discoverPages(),
      // In the order they are found on disk: by path.
      entries: [
        "core",
        "net",
        "net/browser",
        "net/testing",
        "net/worker",
        "physics",
        "runtime",
      ].map(entry),
    });
    const items = Object.fromEntries(
      groups.map((group) => [group.text, group.items?.map((item) => item.link)])
    );
    expect(items.Simulation).toStrictEqual(["/core", "/runtime"]);
    expect(items["Co-op"]).toStrictEqual([
      "/net",
      "/net/browser",
      "/net/testing",
      "/net/worker",
    ]);
    expect(items.More).toStrictEqual(["/physics"]);
    // A group with no entry is left out.
    expect(items.Data).toBeUndefined();
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

  it("skips frontmatter, and stops at a sentence when the paragraph is long", () => {
    const long = `${"A first sentence that says what was decided. ".repeat(4)}And one more that would make it too long to show under a shared link.`;
    expect(
      firstParagraph(`---\nstatus: accepted\n---\n\n# A decision\n\n${long}\n`)
    ).toBe("A first sentence that says what was decided. ".repeat(4).trim());
  });
});
