// Where the site, its repository and its sources are: the addresses its pages and links are
// built from.
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Where the site is served: its canonical address, with no trailing slash. */
export const SITE_URL = "https://arcadekit.dev";
export const REPO_URL = "https://github.com/lucasthevenet/arcadekit";
/** The branch the site is built from, and that its links to GitHub point at. */
export const BRANCH = "main";
export const GRIMBONK_URL = "https://grimbonk.arcadekit.dev";
export const NPM_URL = "https://www.npmjs.com/package/arcadekit";

/** The repository's root on disk. The pages are read from it in place. */
export const REPO_ROOT = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url))
);

/** The site's own folder, relative to the repository's root. */
export const WEBSITE_DIR = "website";
