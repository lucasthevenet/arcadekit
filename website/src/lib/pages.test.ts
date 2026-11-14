import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverPages,
  entryRedirects,
  firstParagraph,
  splitTitle,
} from "./pages.ts";
import type { EntryPage } from "./pages.ts";
import { sidebar } from "./sidebar.ts";
import { REPO_ROOT } from "./site.ts";

const entry = (name: string): EntryPage => ({
  file: `packages/arcadekit/src/${name}/README.md`,
  slug: name,
  link: `/${name}`,
  title: `arcadekit/${name}`,
  description: "",
  body: "",
  entry: name,
});

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
    }
  });

  // The site would build without these two, but the sidebar lists a page by its heading and a
  // shared link shows its first paragraph (website/README.md, "A new entry's README").
  it("has READMEs that start with their import path as the heading, then a paragraph", () => {
    for (const page of pages.entries) {
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

  it("sends the address of an entry with no README to the page that documents it", () => {
    const redirects = entryRedirects(pages);
    expect(redirects).toContainEqual({ from: "/game/testing", to: "/game" });
    expect(redirects).toContainEqual({ from: "/net/signalling", to: "/net" });
    const links = new Set(pages.all.map((page) => page.link));
    for (const { from, to } of redirects) {
      expect(links.has(from)).toBe(false);
      expect(links.has(to)).toBe(true);
    }
    // An entry with a README of its own keeps its address.
    expect(redirects.map(({ from }) => from)).not.toContain("/net/worker");
  });

  it("stops redirecting an entry once it has a README", () => {
    const withBrowser = {
      ...pages,
      entries: [...pages.entries, entry("net/browser")],
    };
    const from = entryRedirects(withBrowser).map((redirect) => redirect.from);
    expect(from).not.toContain("/net/browser");
    expect(from).toContain("/net/signalling");
  });

  it("sends an entry with no page above it to the landing page", () => {
    const redirects = entryRedirects({ ...pages, entries: [] });
    expect(redirects).toContainEqual({ from: "/core", to: "/" });
    expect(redirects).toContainEqual({ from: "/net/browser", to: "/" });
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

describe("the sidebar", () => {
  it("lists an entry no group names, under its top folder's group or under More", () => {
    const groups = sidebar({
      ...discoverPages(),
      // In the order they are found on disk: by path.
      entries: [
        "core",
        "input",
        "net",
        "net/browser",
        "net/testing",
        "net/worker",
        "physics",
      ].map(entry),
    });
    const items = Object.fromEntries(
      groups.flatMap((group) =>
        typeof group === "object" && "items" in group
          ? [[group.label, group.items]]
          : []
      )
    );
    expect(items.Simulation).toStrictEqual(["core", "input"]);
    expect(items["Co-op"]).toStrictEqual([
      "net",
      "net/browser",
      "net/testing",
      "net/worker",
    ]);
    expect(items.More).toStrictEqual(["physics"]);
    // A group with no entry is left out.
    expect(items.Data).toBeUndefined();
    expect(items.Reference).toStrictEqual(["glossary"]);
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
