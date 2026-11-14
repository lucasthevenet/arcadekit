// Which version of the package the site's pages describe.
//
// The site is built from the repository as it is, so its pages follow `main`: between releases
// they can describe an export or an entry that the package on npm doesn't have yet. The
// repository knows when that is so: a change to the package waits in `.changeset/` until the
// release that publishes it (.changeset/README.md). So the header shows the package's version
// alone only when no changeset is waiting, and says "unreleased" when one is
// (components/social-icons.astro, which reads the files as the site builds).

/** Whether a changeset's text releases a package: its frontmatter names it with a bump. */
export const releases = (changeset: string, packageName: string): boolean => {
  const frontmatter = /^---\n(?<body>[\s\S]*?)\n---/u.exec(changeset)?.groups
    ?.body;
  return (frontmatter ?? "")
    .split("\n")
    .some((line) =>
      new RegExp(
        `^["']?${packageName}["']?:\\s*(?:major|minor|patch)\\s*$`,
        "u"
      ).test(line)
    );
};

/**
 * Whether the repository holds changes to the package not yet released: whether one of the
 * markdown files of `.changeset/`, by path, is a changeset that releases it. The folder's README
 * is not a changeset.
 */
export const hasUnreleased = (
  changesets: Readonly<Record<string, string>>,
  packageName: string
): boolean =>
  Object.entries(changesets).some(
    ([file, text]) =>
      !file.endsWith("/README.md") && releases(text, packageName)
  );

/** The header's label for the version: `v0.3.0`, or `v0.3.0 + unreleased`. */
export const versionLabel = (version: string, unreleased: boolean): string =>
  unreleased ? `v${version} + unreleased` : `v${version}`;
