import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./pages.ts";
import { packageVersion, releases, versionLabel } from "./version.ts";

describe("a changeset", () => {
  it("releases the package its frontmatter names with a bump", () => {
    expect(
      releases('---\n"arcadekit": minor\n---\n\nNew entry.\n', "arcadekit")
    ).toBe(true);
    expect(
      releases("---\narcadekit: patch\n---\n\nA fix.\n", "arcadekit")
    ).toBe(true);
  });

  it("doesn't release a package it only mentions, or another package", () => {
    expect(
      releases(
        '---\n"@arcadekit/survivors": minor\n---\n\n"arcadekit": minor\n',
        "arcadekit"
      )
    ).toBe(false);
    expect(releases("---\n---\n\nNothing.\n", "arcadekit")).toBe(false);
    expect(releases("# Changesets\n\n`arcadekit`: minor\n", "arcadekit")).toBe(
      false
    );
  });
});

describe("the version the top bar shows", () => {
  it("is the package's version alone when no change waits for a release", () => {
    expect(versionLabel("0.3.0", false)).toBe("v0.3.0");
  });

  it("says so when the pages are ahead of the release", () => {
    expect(versionLabel("0.3.0", true)).toBe("v0.3.0 + unreleased");
  });

  it("is read from the package and the repository's changesets", () => {
    const { version, unreleased } = packageVersion(REPO_ROOT);
    expect(version).toMatch(/^\d+\.\d+\.\d+/u);
    expect(unreleased).toBeTypeOf("boolean");
  });
});
