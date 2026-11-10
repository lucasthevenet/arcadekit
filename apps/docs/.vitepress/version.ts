// Which version of the package the site's pages describe.
//
// The site is built from the repository as it is, so its pages follow `main`: between releases
// they can describe an export or an entry that the package on npm doesn't have yet. The
// repository knows when that is so: a change to the package waits in `.changeset/` until the
// release that publishes it (.changeset/README.md). So the top bar shows the package's version
// alone only when no changeset is waiting, and says "unreleased" when one is.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const CHANGESET_DIR = ".changeset";
const KIT_MANIFEST = "packages/arcadekit/package.json";

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

/** The package's version, and whether the repository holds changes to it not yet released. */
export const packageVersion = (
  repoRoot: string
): { readonly version: string; readonly unreleased: boolean } => {
  const { name, version } = JSON.parse(
    readFileSync(path.join(repoRoot, KIT_MANIFEST), "utf-8")
  ) as { readonly name: string; readonly version: string };
  const unreleased = readdirSync(path.join(repoRoot, CHANGESET_DIR))
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .some((file) =>
      releases(
        readFileSync(path.join(repoRoot, CHANGESET_DIR, file), "utf-8"),
        name
      )
    );
  return { version, unreleased };
};

/** The top bar's label for the version: `v0.3.0`, or `v0.3.0 + unreleased`. */
export const versionLabel = (version: string, unreleased: boolean): string =>
  unreleased ? `v${version} + unreleased` : `v${version}`;
