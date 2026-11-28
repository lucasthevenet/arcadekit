// Where a page or a section of the site went when it moved, so a link to where it was still
// lands on it.
//
// - A section that moved to another page, such as `/guides/testing#run-the-frame-stage-by-hand`:
//   the fragment never reaches the server, so a script in every page's head sends the reader on.
// - A whole page, such as `/reference/arcadekit/Journal`: the host redirects it, from the
//   `_redirects` file the build writes, in Cloudflare's format.
//
// The build fails when a row goes to a page or an anchor the site doesn't have, or moves from one
// it still has (dead-links.ts).
import { writeFileSync } from "node:fs";

import type { AstroIntegration } from "astro";

/**
 * Each address that moved, a page's or a section's, and the address it has now. Splitting a page
 * or renaming one adds a row.
 */
export const MOVED: Readonly<Record<string, string>> = {
  // #501 split the testing and components guides.
  "/guides/testing#run-the-frame-stage-by-hand":
    "/guides/testing-by-hand#run-the-frame-stage-by-hand",
  "/guides/testing#provide-a-stand-in-by-hand":
    "/guides/testing-by-hand#provide-a-stand-in-by-hand",
  "/guides/testing#record-what-is-drawn":
    "/guides/testing-by-hand#record-what-is-drawn",
  "/guides/components#store-data-that-exists-once-in-a-singleton":
    "/guides/singletons",
  // #467 merged arcadekit/net/Peer into Session, and #471 renamed arcadekit/Journal Replay.
  "/reference/arcadekit/net/Peer": "/reference/arcadekit/net/Session",
  "/reference/arcadekit/Journal": "/reference/arcadekit/Replay",
};

const isSection = (address: string) => address.includes("#");

/** The script that sends a reader from a section's old address to its new one. */
export const followMovedSection = (
  moved: Readonly<Record<string, string>>
): string => {
  const sections = Object.fromEntries(
    Object.entries(moved).filter(([from]) => isSection(from))
  );
  // A block, so that `to` is not a global of the page.
  return `{ const to = ${JSON.stringify(sections)}[location.pathname + location.hash]; if (to !== undefined) location.replace(to); }`;
};

/** Cloudflare's `_redirects` for the pages that moved: one permanent redirect a line. */
export const redirectsFile = (
  moved: Readonly<Record<string, string>>
): string =>
  Object.entries(moved)
    .filter(([from]) => !isSection(from))
    .map(([from, to]) => `${from} ${to} 301\n`)
    .join("");

/** The integration that puts the script in every page's head, and writes `_redirects`. */
export const movedAddresses = (
  moved: Readonly<Record<string, string>>
): AstroIntegration => ({
  name: "arcadekit:moved",
  hooks: {
    "astro:config:setup": ({ injectScript }) => {
      injectScript("head-inline", followMovedSection(moved));
    },
    "astro:build:done": ({ dir }) => {
      writeFileSync(new URL("_redirects", dir), redirectsFile(moved));
    },
  },
});
