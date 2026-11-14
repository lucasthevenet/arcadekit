// What the site adds to the glossary as it renders it. Its file stays as it is, written for
// GitHub.
//
// The glossary (CONTEXT.md) is a list of paragraphs, each starting with its term in bold:
// `**Step**: one fixed-length tick of the simulation`. Here the term is a heading above its
// definition, so each term has an address (`/glossary#step`), a line in the page's table of
// contents and a search result of its own.
//
// Search ranks the glossary's prose lower than an entry's page: a search for an export's name
// matches both, and the reader most often wants how to use it. A term's own heading keeps its
// weight, so it still comes first for the term.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineHastPlugin, defineMdastPlugin } from "satteri";
import type {
  HastPluginDefinition,
  MdastPluginDefinition,
  PluginFactoryContext,
} from "satteri";

export interface GlossaryOptions {
  /** The repository's root on disk. */
  readonly repoRoot: string;
  /** The glossary's file, relative to the repository's root. */
  readonly glossary: string;
}

/** The depth of the heading a term becomes. The table of contents lists depths 2 and 3. */
const TERM_DEPTH = 3;

/**
 * How much a word of the glossary's prose counts in a search, against 1 for a page's prose and
 * more for a heading's (Pagefind's `data-pagefind-weight`).
 */
const PROSE_WEIGHT = "0.5";

export const createGlossaryPlugins = (options: GlossaryOptions) => {
  const glossary = path.join(options.repoRoot, options.glossary);
  const isGlossary = (context: PluginFactoryContext) =>
    context.fileURL !== undefined &&
    fileURLToPath(context.fileURL) === glossary;

  /** Each paragraph that starts `**Term**: ` becomes a heading, the term, above its definition. */
  const terms = (context: PluginFactoryContext): MdastPluginDefinition | null =>
    isGlossary(context)
      ? defineMdastPlugin({
          name: "arcadekit:glossary-terms",
          paragraph(node, ctx) {
            const [term, afterTerm, ...rest] = node.children;
            if (
              ctx.parent(node).type !== "root" ||
              term?.type !== "strong" ||
              afterTerm?.type !== "text" ||
              !afterTerm.value.startsWith(":")
            ) {
              return;
            }
            const definition = afterTerm.value.replace(/^:\s*/u, "");
            ctx.replaceNode(node, [
              { type: "heading", depth: TERM_DEPTH, children: term.children },
              {
                type: "paragraph",
                children: [
                  ...(definition === ""
                    ? []
                    : [{ type: "text" as const, value: definition }]),
                  ...rest,
                ],
              },
            ]);
          },
        })
      : null;

  /** The glossary's prose, every block but a heading, counts for less in a search. */
  const searchWeight = (
    context: PluginFactoryContext
  ): HastPluginDefinition | null =>
    isGlossary(context)
      ? defineHastPlugin({
          name: "arcadekit:glossary-search-weight",
          element: {
            // Every element: the blocks are the root's children.
            filter: [],
            visit(node, ctx) {
              if (
                ctx.parent(node)?.type === "root" &&
                !/^h[1-6]$/u.test(node.tagName)
              ) {
                ctx.setProperty(node, "dataPagefindWeight", PROSE_WEIGHT);
              }
            },
          },
        })
      : null;

  return { terms, searchWeight };
};
