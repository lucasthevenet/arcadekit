// Makes the links the READMEs already have work on the site.
//
// A README is read on GitHub, on npm and here, and its links are written for the first two: a
// relative link to another file of the repository (`../../README.md`, `worker/README.md`,
// `../../../../../apps/survivor-demo/alchemy.run.ts`), or a full GitHub URL where the file isn't
// in the npm package (`https://github.com/.../blob/main/docs/adr/0012-....md`). Here a page is
// served at another address than its file's, so neither kind would land right. This rule
// rewrites each one as the page is rendered, and leaves the READMEs alone:
// - a link to a file that is a page of the site goes to that page;
// - a link to any other file or folder of the repository goes to it on GitHub;
// - a relative link to nothing is a dead link, which the build reports and fails on.
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import type { MarkdownRenderer } from "vitepress";

export interface LinkOptions {
  /** The repository's root on disk. */
  readonly repoRoot: string;
  /** The repository on GitHub, such as `https://github.com/owner/name`. */
  readonly repoUrl: string;
  /** The branch GitHub links point at. */
  readonly branch: string;
  /** Each page's address by its file, relative to the repository's root. */
  readonly pageLinks: ReadonlyMap<string, string>;
  /**
   * For a page that includes another file's markdown: the folder that file's relative links
   * start from, by the page's file. Both are relative to the repository's root.
   */
  readonly linkBases: ReadonlyMap<string, string>;
  /** Called with each dead link the first time it is found. */
  readonly onDeadLink?: (link: DeadLink) => void;
}

/** A relative link that points at nothing in the repository. */
export interface DeadLink {
  /** The page's file, relative to the repository's root. */
  readonly file: string;
  readonly href: string;
}

/** What markdown-it's `env` holds when VitePress renders a page. */
interface PageEnv {
  /** The page's file, or where it is served from when it has a rewrite. */
  readonly path?: string;
  /** The page's file when it has a rewrite. */
  readonly realPath?: string;
}

const HAS_SCHEME = /^[a-z][a-z\d+.-]*:/iu;

const escapeRegExp = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

const toPosix = (file: string) => file.split(path.sep).join("/");

export const createLinkRewriter = (options: LinkOptions) => {
  const { repoRoot, repoUrl, branch, pageLinks, linkBases, onDeadLink } =
    options;
  const dead = new Map<string, DeadLink>();
  const onGitHub = new RegExp(
    `^${escapeRegExp(repoUrl)}/(?:blob|tree)/${escapeRegExp(branch)}/(?<file>[^?#]+)(?<rest>.*)$`,
    "u"
  );

  /** The page a file or folder of the repository is served as, if it is one. */
  const pageOf = (file: string): string | undefined =>
    pageLinks.get(file) ?? pageLinks.get(`${file}/README.md`);

  /**
   * Where a link written in a page's file should point on the site. `pageFile` is relative to
   * the repository's root.
   */
  const rewrite = (href: string, pageFile: string): string => {
    const github = onGitHub.exec(href)?.groups;
    if (github?.file !== undefined) {
      const page = pageOf(decodeURI(github.file).replace(/\/$/u, ""));
      return page === undefined ? href : `${page}${github.rest}`;
    }
    if (HAS_SCHEME.test(href) || href.startsWith("/") || href.startsWith("#")) {
      return href;
    }

    // The path, then the query and the fragment, which the rewritten link keeps.
    const cut = href.search(/[?#]/u);
    const target = cut === -1 ? href : href.slice(0, cut);
    const rest = cut === -1 ? "" : href.slice(cut);
    const from = linkBases.get(pageFile) ?? path.posix.dirname(pageFile);
    const file = path.posix
      .normalize(path.posix.join(from, decodeURI(target)))
      .replace(/\/$/u, "");
    const onDisk = path.join(repoRoot, file);
    if (file.startsWith("..") || !existsSync(onDisk)) {
      const key = `${pageFile}\n${href}`;
      if (!dead.has(key)) {
        const link = { file: pageFile, href };
        dead.set(key, link);
        onDeadLink?.(link);
      }
      return href;
    }
    const page = pageOf(file);
    if (page !== undefined) {
      return `${page}${rest}`;
    }
    const kind = statSync(onDisk).isDirectory() ? "tree" : "blob";
    return `${repoUrl}/${kind}/${branch}/${encodeURI(file)}${rest}`;
  };

  /** The markdown-it plugin: rewrites every link of a page before VitePress renders it. */
  const plugin = (md: MarkdownRenderer): void => {
    md.core.ruler.push("repository-links", (state) => {
      const env = state.env as PageEnv;
      const absolute = env.realPath ?? env.path;
      if (absolute === undefined) {
        return;
      }
      const pageFile = toPosix(path.relative(repoRoot, absolute));
      for (const block of state.tokens) {
        for (const token of block.children ?? []) {
          const href =
            token.type === "link_open" ? token.attrGet("href") : null;
          if (href !== null) {
            token.attrSet("href", rewrite(href, pageFile));
          }
        }
      }
    });
  };

  return {
    plugin,
    rewrite,
    /** The dead links found so far, each once, in the order they were found. */
    deadLinks: (): readonly DeadLink[] => [...dead.values()],
  };
};
