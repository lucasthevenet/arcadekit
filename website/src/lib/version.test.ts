import { describe, expect, it } from "vitest";

import { hasUnreleased, releases, versionLabel } from "./version.ts";

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
        '---\n"@arcadekit/survivor-demo": minor\n---\n\n"arcadekit": minor\n',
        "arcadekit"
      )
    ).toBe(false);
    expect(releases("---\n---\n\nNothing.\n", "arcadekit")).toBe(false);
    expect(releases("# Changesets\n\n`arcadekit`: minor\n", "arcadekit")).toBe(
      false
    );
  });
});

describe("the changesets waiting in .changeset/", () => {
  const release = '---\n"arcadekit": minor\n---\n\nNew entry.\n';

  it("hold an unreleased change when one of them releases the package", () => {
    expect(
      hasUnreleased(
        {
          "../.changeset/new-entry.md": release,
          "../.changeset/README.md": "",
        },
        "arcadekit"
      )
    ).toBe(true);
  });

  it("hold none when none releases it, the folder's README aside", () => {
    expect(hasUnreleased({}, "arcadekit")).toBe(false);
    expect(
      hasUnreleased({ "../.changeset/README.md": release }, "arcadekit")
    ).toBe(false);
  });
});

describe("the version the header shows", () => {
  it("is the package's version alone when no change waits for a release", () => {
    expect(versionLabel("0.3.0", false)).toBe("v0.3.0");
  });

  it("says so when the pages are ahead of the release", () => {
    expect(versionLabel("0.3.0", true)).toBe("v0.3.0 + unreleased");
  });
});
