import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverPages,
  entryRedirects,
  firstParagraph,
  markdownThatIsNotAPage,
  REPO_ROOT,
} from "./pages.ts";
import type { EntryPage } from "./pages.ts";
import { sidebar } from "./sidebar.ts";

const entry = (name: string): EntryPage => ({
  file: `packages/arcadekit/src/${name}/README.md`,
  servedAs: `${name}.md`,
  link: `/${name}`,
  description: "",
  entry: name,
  title: `arcadekit/${name}`,
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
  // shared link shows its first paragraph (apps/docs/README.md, "A new entry's README").
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
      groups.map((group) => [group.text, group.items?.map((item) => item.link)])
    );
    expect(items.Simulation).toStrictEqual(["/core", "/input"]);
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

  it("starts at a paragraph that opens with an issue number, not at a heading", () => {
    expect(
      firstParagraph(
        "# A decision\n\n## Context\n\n#24 asked what a sound is.\n\n**The look.** Pixel art.\n"
      )
    ).toBe("#24 asked what a sound is.");
  });

  it("is the decision's first paragraph for the records that open with an issue number", () => {
    const starts = new Map(
      discoverPages().adrs.map((adr) => [
        adr.number,
        adr.description.split(" ").slice(0, 2).join(" "),
      ])
    );
    expect(starts.get("0009")).toBe("#23 gave");
    expect(starts.get("0012")).toBe("#25 makes");
    expect(starts.get("0014")).toBe("#24 adds");
    expect(starts.get("0015")).toBe("#24 asked");
  });

  it("skips frontmatter, and stops at a sentence when the paragraph is long", () => {
    const long = `${"A first sentence that says what was decided. ".repeat(4)}And one more that would make it too long to show under a shared link.`;
    expect(
      firstParagraph(`---\nstatus: accepted\n---\n\n# A decision\n\n${long}\n`)
    ).toBe("A first sentence that says what was decided. ".repeat(4).trim());
  });
});
