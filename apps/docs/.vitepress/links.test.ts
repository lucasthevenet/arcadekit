import { describe, expect, it } from "vitest";

import { createLinkRewriter } from "./links.ts";
import type { DeadLink } from "./links.ts";
import { REPO_ROOT } from "./pages.ts";

// The repository is the fixture: every file these links name exists in it.
const REPO_URL = "https://github.com/lucasthevenet/arcadekit";
const CORE = "packages/arcadekit/src/core/README.md";
const NET = "packages/arcadekit/src/net/README.md";
const WORKER = "packages/arcadekit/src/net/worker/README.md";
const HOME = "apps/docs/index.md";

const makeRewriter = () => {
  const reported: DeadLink[] = [];
  const links = createLinkRewriter({
    repoRoot: REPO_ROOT,
    repoUrl: REPO_URL,
    branch: "main",
    pageLinks: new Map([
      [HOME, "/"],
      ["packages/arcadekit/README.md", "/"],
      [CORE, "/core"],
      [NET, "/net"],
      [WORKER, "/net/worker"],
      [
        "docs/adr/0012-delay-based-lockstep-over-a-host-star.md",
        "/adr/0012-delay-based-lockstep-over-a-host-star",
      ],
    ]),
    linkBases: new Map([[HOME, "packages/arcadekit"]]),
    onDeadLink: (link) => reported.push(link),
  });
  return { ...links, reported };
};

describe("a relative link in a README", () => {
  it("goes to the page of the file it names", () => {
    const { rewrite, deadLinks } = makeRewriter();
    expect(rewrite("../../README.md", CORE)).toBe("/");
    expect(rewrite("worker/README.md", NET)).toBe("/net/worker");
    expect(rewrite("../README.md", WORKER)).toBe("/net");
    expect(
      rewrite(
        "../../../../../docs/adr/0012-delay-based-lockstep-over-a-host-star.md",
        WORKER
      )
    ).toBe("/adr/0012-delay-based-lockstep-over-a-host-star");
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
      rewrite("../../../../../apps/survivor-demo/alchemy.run.ts", WORKER)
    ).toBe(`${REPO_URL}/blob/main/apps/survivor-demo/alchemy.run.ts`);
    expect(rewrite("../signalling/protocol.ts#L10", WORKER)).toBe(
      `${REPO_URL}/blob/main/packages/arcadekit/src/net/signalling/protocol.ts#L10`
    );
    expect(rewrite("../../../../../apps/survivor-demo", WORKER)).toBe(
      `${REPO_URL}/tree/main/apps/survivor-demo`
    );
    expect(deadLinks()).toStrictEqual([]);
  });

  it("starts from the included file's folder on a page that includes one", () => {
    const { rewrite, deadLinks } = makeRewriter();
    expect(rewrite("src/core/README.md", HOME)).toBe("/core");
    expect(rewrite("src/net/worker/README.md", HOME)).toBe("/net/worker");
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

describe("a full link", () => {
  it("goes to the page when it names a page's file on GitHub", () => {
    const { rewrite } = makeRewriter();
    expect(
      rewrite(
        `${REPO_URL}/blob/main/docs/adr/0012-delay-based-lockstep-over-a-host-star.md#consequences`,
        CORE
      )
    ).toBe("/adr/0012-delay-based-lockstep-over-a-host-star#consequences");
    expect(
      rewrite(`${REPO_URL}/tree/main/packages/arcadekit/src/net/worker`, CORE)
    ).toBe("/net/worker");
  });

  it("is left alone otherwise", () => {
    const { rewrite, deadLinks } = makeRewriter();
    for (const href of [
      `${REPO_URL}/blob/main/packages/arcadekit/CHANGELOG.md`,
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
