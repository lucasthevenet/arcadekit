// What the site adds to the glossary as it renders it. Its file stays as it is, written for
// GitHub.
//
// The glossary (CONTEXT.md) is a list of paragraphs, each starting with its term in bold:
// `**Step**: one fixed-length tick of the simulation`. Here the term is a heading above its
// definition, so each term has an address (`/glossary#step`), a line in the page's outline and a
// search result of its own.
import path from "node:path";

import type { MarkdownRenderer } from "vitepress";

type Token = ReturnType<MarkdownRenderer["parse"]>[number];

export interface ReferenceOptions {
  /** The repository's root on disk. */
  readonly repoRoot: string;
  /** The glossary's file, relative to the repository's root. */
  readonly glossary: string;
}

/** What markdown-it's `env` holds when VitePress renders a page. */
interface PageEnv {
  /** The page's file, or where it is served from when it has a rewrite. */
  readonly path?: string;
  /** The page's file when it has a rewrite. */
  readonly realPath?: string;
}

/** The heading a glossary term becomes. The outline lists levels 2 and 3. */
const TERM_HEADING = "h3";

/** A glossary paragraph's parts: what is inside its leading bold run, and what follows the colon. */
interface TermParagraph {
  readonly term: Token[];
  readonly definition: Token[];
}

/** Splits a paragraph that starts `**Term**: `. Any other paragraph gives `undefined`. */
const termParagraph = (
  children: readonly Token[]
): TermParagraph | undefined => {
  // markdown-it may put an empty text before the bold run.
  const start = children.findIndex(
    (token) => token.type !== "text" || token.content !== ""
  );
  const end = children.findIndex((token) => token.type === "strong_close");
  const [afterTerm, ...rest] = children.slice(end + 1);
  if (
    children[start]?.type !== "strong_open" ||
    afterTerm?.type !== "text" ||
    !afterTerm.content.startsWith(":")
  ) {
    return undefined;
  }
  afterTerm.content = afterTerm.content.replace(/^:\s*/u, "");
  return {
    term: children.slice(start + 1, end),
    definition: [afterTerm, ...rest],
  };
};

export const createReferencePlugin = (options: ReferenceOptions) => {
  const { repoRoot, glossary } = options;

  const pageFile = (env: PageEnv): string | undefined => {
    const absolute = env.realPath ?? env.path;
    return absolute === undefined
      ? undefined
      : path.relative(repoRoot, absolute).split(path.sep).join("/");
  };

  return (md: MarkdownRenderer): void => {
    // Before "anchor", the rule that gives each heading its id and its permalink.
    md.core.ruler.before("anchor", "glossary-terms", (state) => {
      if (pageFile(state.env as PageEnv) !== glossary) {
        return;
      }
      const tokens: Token[] = [];
      for (const [index, token] of state.tokens.entries()) {
        const parts =
          token.type === "inline" &&
          state.tokens[index - 1]?.type === "paragraph_open"
            ? termParagraph(token.children ?? [])
            : undefined;
        if (parts === undefined) {
          tokens.push(token);
          continue;
        }
        // The three tokens markdown-it makes of a `### Term` line.
        const open = new state.Token("heading_open", TERM_HEADING, 1);
        const heading = new state.Token("inline", "", 0);
        const close = new state.Token("heading_close", TERM_HEADING, -1);
        for (const part of [open, heading, close]) {
          part.block = true;
          part.map = token.map;
        }
        open.markup = "#".repeat(Number(TERM_HEADING.slice(1)));
        close.markup = open.markup;
        heading.children = parts.term;
        heading.content = parts.term.map((part) => part.content).join("");
        // The paragraph's `<p>` is the last token so far: the heading goes before it.
        tokens.splice(-1, 0, open, heading, close);
        token.children = parts.definition;
        tokens.push(token);
      }
      state.tokens = tokens;
    });
  };
};
