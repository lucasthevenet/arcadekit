import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { followMovedSection, redirectsFile } from "./moved.ts";

const MOVED = {
  "/guides/testing#by-hand": "/guides/testing-by-hand#by-hand",
  "/reference/Journal": "/reference/Replay",
};

/** Where the script of every page's head sends a reader who opens `pathname` and `hash`. */
const landsAt = (pathname: string, hash: string) => {
  const sentTo: string[] = [];
  const location = {
    pathname,
    hash,
    replace: (to: string) => sentTo.push(to),
  };
  runInNewContext(followMovedSection(MOVED), { location });
  return sentTo;
};

describe("a moved section", () => {
  it("sends a reader from its old address to its new one, in place of the old", () => {
    expect(landsAt("/guides/testing", "#by-hand")).toStrictEqual([
      "/guides/testing-by-hand#by-hand",
    ]);
  });

  it("leaves a reader of the rest of its old page where they are", () => {
    expect(landsAt("/guides/testing", "")).toStrictEqual([]);
    expect(landsAt("/guides/testing", "#make")).toStrictEqual([]);
  });
});

describe("a moved page", () => {
  it("is a permanent redirect of the host, and its script sends no one", () => {
    expect(redirectsFile(MOVED)).toBe(
      "/reference/Journal /reference/Replay 301\n"
    );
    expect(landsAt("/reference/Journal", "")).toStrictEqual([]);
  });
});
