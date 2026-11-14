// Makes the links the READMEs already have work on the site.
//
// A README is read on GitHub, on npm and here, and its links are written for the first two: a
// relative link to another file of the repository (`../../README.md`, `worker/README.md`,
// `../../../../../examples/survivor-demo/alchemy.run.ts`), or a full GitHub URL where the file
// isn't in the npm package (`https://github.com/.../blob/main/CONTEXT.md`). Here a page is
// served at another address than its file's, so neither kind would land right. This plugin
// rewrites each one as the page is rendered, and leaves the READMEs alone:
// - a link to a file that is a page of the site goes to that page;
// - a link to any other file or folder of the repository goes to it on GitHub;
// - a link of either kind to nothing in the repository is a dead link, which the build reports
//   and fails on (astro.config.ts).
// It also links a bare issue number in a page's text (`#25`) to the issue on GitHub.
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineMdastPlugin } from "satteri";
import type {
  MdastContent,
  MdastPluginDefinition,
  MdastVisitorContext,
  MdastNode,
  PluginFactoryContext,
} from "satteri";

export interface LinkOptions {
  /** The repository's root on disk. */
  readonly repoRoot: string;
  /** The repository on GitHub, such as `https://github.com/owner/name`. */
  readonly repoUrl: string;
  /** The branch GitHub links point at. */
  readonly branch: string;
  /** Each page's address by its file, relative to the repository's root. */
  readonly pageLinks: ReadonlyMap<string, string>;
  /** Called with each dead link the first time it is found. */
  readonly onDeadLink?: (link: DeadLink) => void;
}

/** A link to a file of the repository that points at nothing in it. */
export interface DeadLink {
  /** The file the link is written in, relative to the repository's root. */
  readonly file: string;
  readonly href: string;
}

/** A piece of a page's text: plain, or an issue number with the issue's address. */
export interface TextPart {
  readonly text: string;
  readonly href?: string;
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

/** Whether a node is inside a link or a heading, whose text is left as it is. */
const inLinkOrHeading = (node: MdastNode, ctx: MdastVisitorContext) => {
  for (let parent = ctx.parent(node); parent; parent = ctx.parent(parent)) {
    if (
      parent.type === "link" ||
      parent.type === "linkReference" ||
      parent.type === "heading"
    ) {
      return true;
    }
  }
  return false;
};

export const createLinkRewriter = (options: LinkOptions) => {
  const { repoRoot, repoUrl, branch, pageLinks, onDeadLink } = options;
  const dead = new Map<string, DeadLink>();
  const onGitHub = new RegExp(
    `^${escapeRegExp(repoUrl)}/(?:blob|tree)/${escapeRegExp(branch)}/(?<file>[^?#]+)(?<rest>.*)$`,
    "u"
  );

  /** The page a file or folder of the repository is served as, if it is one. */
  const pageOf = (file: string): string | undefined =>
    pageLinks.get(file) ?? pageLinks.get(`${file}/README.md`);

  /** Records a dead link, and reports it the first time. Returns the link as it was written. */
  const deadLink = (href: string, file: string): string => {
    const key = `${file}\n${href}`;
    if (!dead.has(key)) {
      const link: DeadLink = { file, href };
      dead.set(key, link);
      onDeadLink?.(link);
    }
    return href;
  };

  /** Whether a path names a file or folder of the repository. */
  const inRepository = (file: string) =>
    !file.startsWith("..") && existsSync(path.join(repoRoot, file));

  /**
   * Where a link written in a file of the repository should point on the site. `file` is
   * relative to the repository's root.
   */
  const rewrite = (href: string, file: string): string => {
    const github = onGitHub.exec(href)?.groups;
    if (github?.file !== undefined) {
      const target = path.posix
        .normalize(decodeURI(github.file))
        .replace(/\/$/u, "");
      const page = pageOf(target);
      if (page !== undefined) {
        return `${page}${github.rest}`;
      }
      // It stays a link to GitHub, where a file this checkout doesn't have is a 404.
      return inRepository(target) ? href : deadLink(href, file);
    }
    if (HAS_SCHEME.test(href) || href.startsWith("/") || href.startsWith("#")) {
      return href;
    }

    // The path, then the query and the fragment, which the rewritten link keeps.
    const cut = href.search(/[?#]/u);
    const relative = cut === -1 ? href : href.slice(0, cut);
    const rest = cut === -1 ? "" : href.slice(cut);
    const target = path.posix
      .normalize(path.posix.join(path.posix.dirname(file), decodeURI(relative)))
      .replace(/\/$/u, "");
    if (!inRepository(target)) {
      return deadLink(href, file);
    }
    const page = pageOf(target);
    if (page !== undefined) {
      return `${page}${rest}`;
    }
    const kind = statSync(path.join(repoRoot, target)).isDirectory()
      ? "tree"
      : "blob";
    return `${repoUrl}/${kind}/${branch}/${encodeURI(target)}${rest}`;
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
   * The Sätteri mdast plugin, for a file of the repository: rewrites each of its links, and
   * links each bare issue number in its text. A heading's text is left as it is, since its words
   * are also its anchor and its line in the table of contents. Markdown from anywhere else, or
   * from no file, is left alone.
   */
  const plugin = (
    context: PluginFactoryContext
  ): MdastPluginDefinition | null => {
    if (context.fileURL === undefined) {
      return null;
    }
    const file = toPosix(
      path.relative(repoRoot, fileURLToPath(context.fileURL))
    );
    if (file.startsWith("..")) {
      return null;
    }
    return defineMdastPlugin({
      name: "arcadekit:repository-links",
      link(node, ctx) {
        const href = rewrite(node.url, file);
        if (href !== node.url) {
          ctx.setField(node, "url", href);
        }
      },
      definition(node, ctx) {
        const href = rewrite(node.url, file);
        if (href !== node.url) {
          ctx.setField(node, "url", href);
        }
      },
      text(node, ctx) {
        const parts = issueLinks(node.value);
        if (
          parts.every((part) => part.href === undefined) ||
          inLinkOrHeading(node, ctx)
        ) {
          return;
        }
        ctx.replaceNode(
          node,
          parts.map(({ text, href }): MdastContent =>
            href === undefined
              ? { type: "text", value: text }
              : {
                  type: "link",
                  url: href,
                  children: [{ type: "text", value: text }],
                }
          )
        );
      },
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
