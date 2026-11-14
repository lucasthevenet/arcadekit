// Fails the build on a dead link.
//
// Two kinds of link are checked, each where it can be:
// - A link a page writes to a file of the repository, relative or a full URL to GitHub: as the
//   page renders, by links.ts, which knows the file it is written in.
// - A link to a page of the site, as the built site has it: the pages' links once rewritten,
//   the landing page's, the sidebar's and the redirects'. Its page must exist, and its fragment,
//   if it has one, must be an anchor on that page: a heading of a page, a term of the glossary.
//   GitHub gives a heading the same anchor, so a fragment that works here works there too, except
//   a term's, which is a heading only here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AstroIntegration } from "astro";

import type { DeadLink } from "./links.ts";

/** A link of the built site to a page or an anchor it doesn't have. */
export interface BrokenLink {
  /** The address of the page the link is on, such as `/net/worker`. */
  readonly page: string;
  readonly href: string;
  readonly reason: string;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
};

/** An attribute's value as the browser reads it. */
const unescape = (value: string) =>
  value.replaceAll(
    /&(?:#(?<code>\d+)|(?<name>[a-z]+));/gu,
    (entity, code?: string, name?: string) =>
      code === undefined
        ? (ENTITIES[name ?? ""] ?? entity)
        : String.fromCodePoint(Number(code))
  );

/** Every file under a folder, relative to it, with `/` between folders. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true })
    .map((file) => String(file).split(path.sep).join("/"))
    .filter((file) => statSync(path.join(dir, file)).isFile());

const LINK = /<a\s[^>]*?\bhref="(?<href>[^"]*)"/gu;
const ID = /\sid="(?<id>[^"]*)"/gu;

/** The built file an address of the site is served from, as Cloudflare serves it. */
const servedFrom = (
  files: ReadonlySet<string>,
  address: string
): string | undefined => {
  const file = address.replace(/^\//u, "").replace(/\/$/u, "");
  return [
    file === "" ? "index.html" : `${file}.html`,
    `${file}/index.html`,
    file,
  ].find((candidate) => files.has(candidate));
};

/** The address a built page is served at: `net/worker/index.html` at `/net/worker`. */
const addressOf = (file: string) =>
  `/${file.replace(/(?:^|\/)index\.html$/u, "").replace(/\.html$/u, "")}`;

/** Every link of a built site, in `dist`, to a page or an anchor it doesn't have. */
export const findBrokenLinks = (dist: string): BrokenLink[] => {
  const files = new Set(filesUnder(dist));
  const html = new Map(
    [...files]
      .filter((file) => file.endsWith(".html"))
      .map((file) => [file, readFileSync(path.join(dist, file), "utf-8")])
  );
  const anchors = new Map<string, ReadonlySet<string>>();
  const anchorsOf = (page: string) => {
    let ids = anchors.get(page);
    if (ids === undefined) {
      ids = new Set(
        [...(html.get(page) ?? "").matchAll(ID)].map((match) =>
          unescape(match.groups?.id ?? "")
        )
      );
      anchors.set(page, ids);
    }
    return ids;
  };

  const broken: BrokenLink[] = [];
  for (const [page, text] of html) {
    for (const match of text.matchAll(LINK)) {
      const href = unescape(match.groups?.href ?? "");
      // A link to another site, or to a page by a relative path, which the site doesn't write.
      if (!href.startsWith("/") && !href.startsWith("#")) {
        continue;
      }
      if (href.startsWith("//")) {
        continue;
      }
      const cut = href.search(/[?#]/u);
      const address = cut === -1 ? href : href.slice(0, cut);
      const fragment = /#(?<fragment>.+)$/u.exec(href)?.groups?.fragment;
      const target = address === "" ? page : servedFrom(files, address);
      if (target === undefined) {
        broken.push({
          page: addressOf(page),
          href,
          reason: "no page has this address",
        });
        continue;
      }
      if (
        fragment !== undefined &&
        target.endsWith(".html") &&
        !anchorsOf(target).has(decodeURIComponent(fragment))
      ) {
        broken.push({
          page: addressOf(page),
          href,
          reason: `${addressOf(target)} has no heading or anchor "${decodeURIComponent(fragment)}"`,
        });
      }
    }
  }
  return broken;
};

/**
 * The integration that fails `astro build` on a dead link of either kind, listing every one.
 * `astro dev` renders a page at a time, so it only warns, through links.ts.
 */
export const deadLinks = (repositoryLinks: {
  readonly deadLinks: () => readonly DeadLink[];
}): AstroIntegration => ({
  name: "arcadekit:dead-links",
  hooks: {
    "astro:build:done": ({ dir }) => {
      const messages = [
        ...repositoryLinks
          .deadLinks()
          .map(
            ({ href, file }) =>
              `  ${href} in ${file}: no file or folder of the repository`
          ),
        ...findBrokenLinks(fileURLToPath(dir)).map(
          ({ href, page, reason }) => `  ${href} on ${page}: ${reason}`
        ),
      ];
      if (messages.length > 0) {
        throw new Error(
          [`${messages.length} dead link(s):`, ...messages].join("\n")
        );
      }
    },
  },
});
