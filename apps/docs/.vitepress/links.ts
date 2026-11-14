// Makes the links the READMEs already have work on the site.
//
// A README is read on GitHub, on npm and here, and its links are written for the first two: a
// relative link to another file of the repository (`../../README.md`, `worker/README.md`,
// `../../../../../apps/survivor-demo/alchemy.run.ts`), or a full GitHub URL where the file isn't
// in the npm package (`https://github.com/.../blob/main/CONTEXT.md`). Here a page is
// served at another address than its file's, so neither kind would land right. This rule
// rewrites each one as the page is rendered, and leaves the READMEs alone:
// - a link to a file that is a page of the site goes to that page;
// - a link to any other file or folder of the repository goes to it on GitHub;
// - a link of either kind to nothing in the repository is a dead link, which the build reports
//   and fails on.
// It also links a bare issue number in a page's text (`#25`) to the issue on GitHub.
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
   * The file a page includes, by the page's file, for a page that is mostly another file's
   * markdown. The page's relative links start from the included file's folder. Both are relative
   * to the repository's root.
   */
  readonly includes: ReadonlyMap<string, string>;
  /** Called with each dead link the first time it is found. */
  readonly onDeadLink?: (link: DeadLink) => void;
}

/** A link to a file of the repository that points at nothing in it. */
export interface DeadLink {
  /** The page's file, relative to the repository's root. */
  readonly file: string;
  /** The file the page includes, if it includes one: the link may be written there. */
  readonly includes?: string;
  readonly href: string;
}

/** Where a dead link is written, for a message: the page's file, and the file it includes. */
export const whereIs = ({ file, includes }: DeadLink): string =>
  includes === undefined ? file : `${file} or ${includes}, which it includes`;

/** A piece of a page's text: plain, or an issue number with the issue's address. */
export interface TextPart {
  readonly text: string;
  readonly href?: string;
}

type Token = ReturnType<MarkdownRenderer["parse"]>[number];

/** What markdown-it's `env` holds when VitePress renders a page. */
interface PageEnv {
  /** The page's file, or where it is served from when it has a rewrite. */
  readonly path?: string;
  /** The page's file when it has a rewrite. */
  readonly realPath?: string;
}

const HAS_SCHEME = /^[a-z][a-z\d+.-]*:/iu;

/**
 * A bare issue or pull request number, such as `#25`: not part of a word, a path, a fragment or
 * a colour (`#17151f`).
 */
const ISSUE_NUMBER = /(?<![\w&#/])#(?<number>\d+)\b/gu;

const escapeRegExp = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

const toPosix = (file: string) => file.split(path.sep).join("/");

export const createLinkRewriter = (options: LinkOptions) => {
  const { repoRoot, repoUrl, branch, pageLinks, includes, onDeadLink } =
    options;
  const dead = new Map<string, DeadLink>();
  const onGitHub = new RegExp(
    `^${escapeRegExp(repoUrl)}/(?:blob|tree)/${escapeRegExp(branch)}/(?<file>[^?#]+)(?<rest>.*)$`,
    "u"
  );

  /** The page a file or folder of the repository is served as, if it is one. */
  const pageOf = (file: string): string | undefined =>
    pageLinks.get(file) ?? pageLinks.get(`${file}/README.md`);

  /** Records a dead link, and reports it the first time. Returns the link as it was written. */
  const deadLink = (href: string, pageFile: string): string => {
    const key = `${pageFile}\n${href}`;
    if (!dead.has(key)) {
      const included = includes.get(pageFile);
      const link: DeadLink = {
        file: pageFile,
        ...(included === undefined ? {} : { includes: included }),
        href,
      };
      dead.set(key, link);
      onDeadLink?.(link);
    }
    return href;
  };

  /** Whether a path names a file or folder of the repository. */
  const inRepository = (file: string) =>
    !file.startsWith("..") && existsSync(path.join(repoRoot, file));

  /**
   * Where a link written in a page's file should point on the site. `pageFile` is relative to
   * the repository's root.
   */
  const rewrite = (href: string, pageFile: string): string => {
    const github = onGitHub.exec(href)?.groups;
    if (github?.file !== undefined) {
      const file = path.posix
        .normalize(decodeURI(github.file))
        .replace(/\/$/u, "");
      const page = pageOf(file);
      if (page !== undefined) {
        return `${page}${github.rest}`;
      }
      // It stays a link to GitHub, where a file this checkout doesn't have is a 404.
      return inRepository(file) ? href : deadLink(href, pageFile);
    }
    if (HAS_SCHEME.test(href) || href.startsWith("/") || href.startsWith("#")) {
      return href;
    }

    // The path, then the query and the fragment, which the rewritten link keeps.
    const cut = href.search(/[?#]/u);
    const target = cut === -1 ? href : href.slice(0, cut);
    const rest = cut === -1 ? "" : href.slice(cut);
    const from = path.posix.dirname(includes.get(pageFile) ?? pageFile);
    const file = path.posix
      .normalize(path.posix.join(from, decodeURI(target)))
      .replace(/\/$/u, "");
    if (!inRepository(file)) {
      return deadLink(href, pageFile);
    }
    const page = pageOf(file);
    if (page !== undefined) {
      return `${page}${rest}`;
    }
    const kind = statSync(path.join(repoRoot, file)).isDirectory()
      ? "tree"
      : "blob";
    return `${repoUrl}/${kind}/${branch}/${encodeURI(file)}${rest}`;
  };

  /**
   * A text cut at each bare issue number, which gets the issue's address. GitHub sends an issue's
   * address to the pull request when the number is one.
   */
  const issueLinks = (text: string): TextPart[] => {
    const parts: TextPart[] = [];
    let end = 0;
    for (const match of text.matchAll(ISSUE_NUMBER)) {
      if (match.index > end) {
        parts.push({ text: text.slice(end, match.index) });
      }
      parts.push({
        text: match[0],
        href: `${repoUrl}/issues/${match.groups?.number}`,
      });
      end = match.index + match[0].length;
    }
    if (end < text.length) {
      parts.push({ text: text.slice(end) });
    }
    return parts;
  };

  /**
   * The markdown-it plugin: before VitePress renders a page, rewrites each of its links and
   * links each bare issue number in its text. A heading's text is left as it is, since its
   * words are also its anchor and its line in the outline.
   */
  const plugin = (md: MarkdownRenderer): void => {
    md.core.ruler.push("repository-links", (state) => {
      const env = state.env as PageEnv;
      const absolute = env.realPath ?? env.path;
      if (absolute === undefined) {
        return;
      }
      const pageFile = toPosix(path.relative(repoRoot, absolute));
      for (const [index, block] of state.tokens.entries()) {
        if (block.children === null) {
          continue;
        }
        const inHeading = state.tokens[index - 1]?.type === "heading_open";
        const children: Token[] = [];
        let linkDepth = 0;
        for (const token of block.children) {
          if (token.type === "link_open") {
            linkDepth += 1;
            const href = token.attrGet("href");
            if (href !== null) {
              token.attrSet("href", rewrite(href, pageFile));
            }
          } else if (token.type === "link_close") {
            linkDepth -= 1;
          }
          const parts =
            token.type === "text" && linkDepth === 0 && !inHeading
              ? issueLinks(token.content)
              : [];
          if (parts.every((part) => part.href === undefined)) {
            children.push(token);
            continue;
          }
          for (const part of parts) {
            const text = new state.Token("text", "", 0);
            text.content = part.text;
            if (part.href === undefined) {
              children.push(text);
              continue;
            }
            const open = new state.Token("link_open", "a", 1);
            open.attrSet("href", part.href);
            children.push(open, text, new state.Token("link_close", "a", -1));
          }
        }
        block.children = children;
      }
    });
  };

  return {
    plugin,
    rewrite,
    issueLinks,
    /** The dead links found so far, each once, in the order they were found. */
    deadLinks: (): readonly DeadLink[] => [...dead.values()],
  };
};
