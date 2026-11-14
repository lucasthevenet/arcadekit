import path from "node:path";
import { pathToFileURL } from "node:url";

import { markdownToHtml } from "satteri";
import { describe, expect, it } from "vitest";

import { createLinkRewriter } from "./links.ts";
import type { DeadLink } from "./links.ts";
import { REPO_ROOT } from "./site.ts";

// The repository is the fixture: every file these links name exists in it.
const REPO_URL = "https://github.com/lucasthevenet/arcadekit";
const CORE = "packages/arcadekit/src/core/README.md";
const NET = "packages/arcadekit/src/net/README.md";
const WORKER = "packages/arcadekit/src/net/worker/README.md";
const PACKAGE_README = "packages/arcadekit/README.md";

const makeRewriter = () => {
  const reported: DeadLink[] = [];
  const links = createLinkRewriter({
    repoRoot: REPO_ROOT,
    repoUrl: REPO_URL,
    branch: "main",
    pageLinks: new Map([
      ["website/src/content/docs/index.mdx", "/"],
      [PACKAGE_README, "/"],
      [CORE, "/core"],
      [NET, "/net"],
      [WORKER, "/net/worker"],
      ["CONTEXT.md", "/glossary"],
    ]),
    onDeadLink: (link) => reported.push(link),
  });
  return { ...links, reported };
};

/** Renders markdown as a file of the repository, with the rewriter's plugin. */
const render = async (markdown: string, file = CORE) => {
  const { html } = await markdownToHtml(markdown, {
    mdastPlugins: [makeRewriter().plugin],
    fileURL: pathToFileURL(path.join(REPO_ROOT, file)),
  });
  return html;
};

describe("a relative link in a README", () => {
  it("goes to the page of the file it names", () => {
    const { rewrite, deadLinks } = makeRewriter();
    expect(rewrite("../../README.md", CORE)).toBe("/");
    expect(rewrite("worker/README.md", NET)).toBe("/net/worker");
    expect(rewrite("../README.md", WORKER)).toBe("/net");
    expect(rewrite("../../../../../CONTEXT.md", WORKER)).toBe("/glossary");
    expect(deadLinks()).toStrictEqual([]);
  });

  it("goes to an entry's page when it names the entry's folder", () => {
    const { rewrite } = makeRewriter();
    expect(rewrite("../core", NET)).toBe("/core");
    expect(rewrite("../core/", NET)).toBe("/core");
  });

  it("keeps its fragment and its query", () => {
    const { rewrite } = makeRewriter();
    expect(rewrite("../../README.md#entries", CORE)).toBe("/#entries");
    expect(rewrite("worker/README.md?plain=1#abuse", NET)).toBe(
      "/net/worker?plain=1#abuse"
    );
  });

  it("goes to GitHub when the file is not a page", () => {
    const { rewrite, deadLinks } = makeRewriter();
    expect(
      rewrite("../../../../../examples/survivor-demo/alchemy.run.ts", WORKER)
    ).toBe(`${REPO_URL}/blob/main/examples/survivor-demo/alchemy.run.ts`);
    expect(rewrite("../signalling/join-code.ts#L10", WORKER)).toBe(
      `${REPO_URL}/blob/main/packages/arcadekit/src/net/signalling/join-code.ts#L10`
    );
    expect(rewrite("../../../../../examples/survivor-demo", WORKER)).toBe(
      `${REPO_URL}/tree/main/examples/survivor-demo`
    );
    expect(deadLinks()).toStrictEqual([]);
  });

  it("starts from the package README's folder on the landing page, which includes it", () => {
    const { rewrite, deadLinks } = makeRewriter();
    expect(rewrite("src/core/README.md", PACKAGE_README)).toBe("/core");
    expect(rewrite("src/net/worker/README.md", PACKAGE_README)).toBe(
      "/net/worker"
    );
    expect(deadLinks()).toStrictEqual([]);
  });

  it("is dead when it names nothing, and is reported once", () => {
    const { rewrite, deadLinks, reported } = makeRewriter();
    expect(rewrite("../nope/README.md", CORE)).toBe("../nope/README.md");
    expect(rewrite("../nope/README.md", CORE)).toBe("../nope/README.md");
    // Out of the repository.
    expect(rewrite("../../../../../README.md", CORE)).toBe(
      "../../../../../README.md"
    );
    const dead = [
      { file: CORE, href: "../nope/README.md" },
      { file: CORE, href: "../../../../../README.md" },
    ];
    expect(deadLinks()).toStrictEqual(dead);
    expect(reported).toStrictEqual(dead);
  });
});

describe("the plugin", () => {
  it("rewrites the links of a page as it renders", async () => {
    const html = await render(
      "See [the net](../net/README.md#co-op), [the demo](../../../../examples/survivor-demo) and [Effect](https://effect.website).\n"
    );
    expect(html).toContain('<a href="/net#co-op">the net</a>');
    expect(html).toContain(
      `<a href="${REPO_URL}/tree/main/examples/survivor-demo">the demo</a>`
    );
    expect(html).toContain('<a href="https://effect.website">Effect</a>');
  });

  it("leaves markdown from outside the repository, or from no file, alone", async () => {
    const { plugin } = makeRewriter();
    const markdown = "See [it](../net/README.md), as #25 asked.\n";
    const outside = await markdownToHtml(markdown, {
      mdastPlugins: [plugin],
      fileURL: pathToFileURL(path.join(path.dirname(REPO_ROOT), "README.md")),
    });
    const nowhere = await markdownToHtml(markdown, { mdastPlugins: [plugin] });
    for (const { html } of [outside, nowhere]) {
      expect(html).toBe(
        '<p>See <a href="../net/README.md">it</a>, as #25 asked.</p>\n'
      );
    }
  });
});

describe("a full link", () => {
  it("goes to the page when it names a page's file on GitHub", () => {
    const { rewrite } = makeRewriter();
    expect(rewrite(`${REPO_URL}/blob/main/CONTEXT.md#lockstep`, CORE)).toBe(
      "/glossary#lockstep"
    );
    expect(
      rewrite(`${REPO_URL}/tree/main/packages/arcadekit/src/net/worker`, CORE)
    ).toBe("/net/worker");
  });

  it("is dead when it names a file the repository doesn't have", () => {
    const { rewrite, deadLinks } = makeRewriter();
    const renamed = `${REPO_URL}/blob/main/packages/arcadekit/src/core/RENAMED.md`;
    const missing = `${REPO_URL}/tree/main/packages/arcadekit/src/nope`;
    const outside = `${REPO_URL}/blob/main/../other/README.md`;
    for (const href of [renamed, missing, outside]) {
      expect(rewrite(href, CORE)).toBe(href);
    }
    expect(deadLinks()).toStrictEqual(
      [renamed, missing, outside].map((href) => ({ file: CORE, href }))
    );
  });

  it("is left alone otherwise", () => {
    const { rewrite, deadLinks } = makeRewriter();
    for (const href of [
      `${REPO_URL}/blob/main/packages/arcadekit/CHANGELOG.md`,
      `${REPO_URL}/tree/main/.changeset`,
      // Another branch, which this checkout can't check.
      `${REPO_URL}/blob/next/packages/arcadekit/src/not-written-yet/README.md`,
      `${REPO_URL}/issues/25`,
      `${REPO_URL}#readme`,
      "https://effect.website",
      "mailto:someone@example.com",
      "//example.com/page",
      "/core",
      "#install",
    ]) {
      expect(rewrite(href, CORE)).toBe(href);
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
