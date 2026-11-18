import path from "node:path";
import { pathToFileURL } from "node:url";

import { markdownToHtml } from "satteri";
import { describe, expect, it } from "vitest";

import { createLinkRewriter } from "./links.ts";
import type { DeadLink } from "./links.ts";
import { REPO_ROOT } from "./site.ts";

// The repository is the fixture: every file these links name exists in it.
const REPO_URL = "https://github.com/lucasthevenet/arcadekit";
const KIT = "packages/arcadekit/README.md";
const THREE = "packages/three/README.md";
const ROADMAP = "ROADMAP.md";
const CONVENTIONS = "docs/conventions.md";

const makeRewriter = () => {
  const reported: DeadLink[] = [];
  const links = createLinkRewriter({
    repoRoot: REPO_ROOT,
    repoUrl: REPO_URL,
    branch: "main",
    pageLinks: new Map([
      ["website/src/content/docs/index.mdx", "/"],
      [KIT, "/reference/arcadekit"],
      [THREE, "/reference/three"],
      [ROADMAP, "/roadmap"],
      [CONVENTIONS, "/conventions"],
    ]),
    onDeadLink: (link) => reported.push(link),
  });
  return { ...links, reported };
};

/** Renders markdown as a file of the repository, with the rewriter's plugin. */
const render = async (markdown: string, file = THREE) => {
  const { html } = await markdownToHtml(markdown, {
    mdastPlugins: [makeRewriter().plugin],
    fileURL: pathToFileURL(path.join(REPO_ROOT, file)),
  });
  return html;
};

describe("a relative link in a README", () => {
  it("goes to the page of the file it names", () => {
    const { rewrite, deadLinks } = makeRewriter();
    expect(rewrite("../arcadekit/README.md", THREE)).toBe(
      "/reference/arcadekit"
    );
    expect(rewrite("../../ROADMAP.md", KIT)).toBe("/roadmap");
    expect(rewrite("docs/conventions.md", ROADMAP)).toBe("/conventions");
    expect(deadLinks()).toStrictEqual([]);
  });

  it("goes to a package's page when it names the package's folder", () => {
    const { rewrite } = makeRewriter();
    expect(rewrite("../three", KIT)).toBe("/reference/three");
    expect(rewrite("../three/", KIT)).toBe("/reference/three");
  });

  it("keeps its fragment and its query", () => {
    const { rewrite } = makeRewriter();
    expect(rewrite("../arcadekit/README.md#input", THREE)).toBe(
      "/reference/arcadekit#input"
    );
    expect(rewrite("../../ROADMAP.md?plain=1#housekeeping", KIT)).toBe(
      "/roadmap?plain=1#housekeeping"
    );
  });

  it("goes to GitHub when the file is not a page", () => {
    const { rewrite, deadLinks } = makeRewriter();
    expect(rewrite("src/App.ts", KIT)).toBe(
      `${REPO_URL}/blob/main/packages/arcadekit/src/App.ts`
    );
    expect(rewrite("src/App.ts#L10", KIT)).toBe(
      `${REPO_URL}/blob/main/packages/arcadekit/src/App.ts#L10`
    );
    expect(rewrite("examples/demo/", KIT)).toBe(
      `${REPO_URL}/tree/main/packages/arcadekit/examples/demo`
    );
    expect(deadLinks()).toStrictEqual([]);
  });

  it("is dead when it names nothing, and is reported once", () => {
    const { rewrite, deadLinks, reported } = makeRewriter();
    expect(rewrite("../nope/README.md", THREE)).toBe("../nope/README.md");
    expect(rewrite("../nope/README.md", THREE)).toBe("../nope/README.md");
    // Out of the repository.
    expect(rewrite("../../../README.md", THREE)).toBe("../../../README.md");
    const dead = [
      { file: THREE, href: "../nope/README.md" },
      { file: THREE, href: "../../../README.md" },
    ];
    expect(deadLinks()).toStrictEqual(dead);
    expect(reported).toStrictEqual(dead);
  });
});

describe("the plugin", () => {
  it("rewrites the links of a page as it renders", async () => {
    const html = await render(
      "See [the frame](../arcadekit/README.md#the-tick-and-the-frame), [the page](examples/page) and [Effect](https://effect.website).\n"
    );
    expect(html).toContain(
      '<a href="/reference/arcadekit#the-tick-and-the-frame">the frame</a>'
    );
    expect(html).toContain(
      `<a href="${REPO_URL}/tree/main/packages/three/examples/page">the page</a>`
    );
    expect(html).toContain('<a href="https://effect.website">Effect</a>');
  });

  it("leaves markdown from outside the repository, or from no file, alone", async () => {
    const { plugin } = makeRewriter();
    const markdown = "See [it](../three/README.md), as #25 asked.\n";
    const outside = await markdownToHtml(markdown, {
      mdastPlugins: [plugin],
      fileURL: pathToFileURL(path.join(path.dirname(REPO_ROOT), "README.md")),
    });
    const nowhere = await markdownToHtml(markdown, { mdastPlugins: [plugin] });
    for (const { html } of [outside, nowhere]) {
      expect(html).toBe(
        '<p>See <a href="../three/README.md">it</a>, as #25 asked.</p>\n'
      );
    }
  });
});

describe("a full link", () => {
  it("goes to the page when it names a page's file on GitHub", () => {
    const { rewrite } = makeRewriter();
    expect(rewrite(`${REPO_URL}/blob/main/ROADMAP.md#housekeeping`, KIT)).toBe(
      "/roadmap#housekeeping"
    );
    expect(rewrite(`${REPO_URL}/tree/main/packages/three`, KIT)).toBe(
      "/reference/three"
    );
  });

  it("is dead when it names a file the repository doesn't have", () => {
    const { rewrite, deadLinks } = makeRewriter();
    const renamed = `${REPO_URL}/blob/main/packages/arcadekit/src/RENAMED.ts`;
    const missing = `${REPO_URL}/tree/main/packages/nope`;
    const outside = `${REPO_URL}/blob/main/../other/README.md`;
    for (const href of [renamed, missing, outside]) {
      expect(rewrite(href, KIT)).toBe(href);
    }
    expect(deadLinks()).toStrictEqual(
      [renamed, missing, outside].map((href) => ({ file: KIT, href }))
    );
  });

  it("is left alone otherwise", () => {
    const { rewrite, deadLinks } = makeRewriter();
    for (const href of [
      `${REPO_URL}/blob/main/packages/arcadekit/src/App.ts`,
      `${REPO_URL}/tree/main/.changeset`,
      // Another branch, which this checkout can't check.
      `${REPO_URL}/blob/next/packages/arcadekit/src/core/README.md`,
      `${REPO_URL}/issues/25`,
      `${REPO_URL}#readme`,
      "https://effect.website",
      "mailto:someone@example.com",
      "//example.com/page",
      "/reference/arcadekit",
      "#install",
    ]) {
      expect(rewrite(href, KIT)).toBe(href);
    }
    expect(deadLinks()).toStrictEqual([]);
  });
});

describe("a bare issue number", () => {
  it("gets the issue's address on GitHub", () => {
    const { issueLinks } = makeRewriter();
    expect(issueLinks("as #25 asked (#52-#55).")).toStrictEqual([
      { text: "as " },
      { text: "#25", href: `${REPO_URL}/issues/25` },
      { text: " asked (" },
      { text: "#52", href: `${REPO_URL}/issues/52` },
      { text: "-" },
      { text: "#55", href: `${REPO_URL}/issues/55` },
      { text: ")." },
    ]);
  });

  it("is not part of a colour, a word, an address or an entity", () => {
    const { issueLinks } = makeRewriter();
    for (const text of [
      "the colour #17151f",
      "the colour #000000ff",
      "item#3",
      "see /page#2",
      "a &#39; mark",
      "no number # 4",
    ]) {
      expect(issueLinks(text)).toStrictEqual([{ text }]);
    }
  });

  it("is linked in a page's text", async () => {
    const html = await render("#25 makes co-op, as #24 did.\n");
    expect(html).toContain(
      `<p><a href="${REPO_URL}/issues/25">#25</a> makes co-op, as <a href="${REPO_URL}/issues/24">#24</a> did.</p>`
    );
  });

  it("is left as it is in code, in a link and in a heading", async () => {
    const html = await render(
      "# What #26 asked\n\nSee [#30](https://example.com/30) and `#7`.\n"
    );
    expect(html).toContain('<a href="https://example.com/30"');
    expect(html).toContain("<code>#7</code>");
    expect(html).not.toContain("/issues/");
  });
});
