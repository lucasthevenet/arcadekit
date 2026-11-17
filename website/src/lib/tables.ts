// Lets a path in a table's cell wrap, so a table fits a phone.
//
// The READMEs' tables hold names in code, such as `arcadekit/game/browser`. A browser never
// breaks one, so a column is as wide as its longest name, and on a phone the entries' table was
// nearly twice the page's width. Here a name in a cell may break after each slash: the browser
// takes the break only when the name doesn't fit its line, and a copied name has no mark of it.
// src/styles/custom.css does the rest.
import { defineHastPlugin } from "satteri";
import type { HastContent } from "satteri";

/** A name's pieces, between the places it may break: after each slash. */
export const namePieces = (name: string): string[] => name.split(/(?<=\/)/u);

/** The Sätteri hast plugin: a `<wbr>` after each slash of the code in a table's body cell. */
export const tableNames = defineHastPlugin({
  name: "arcadekit:table-names",
  element: [
    {
      filter: ["code"],
      visit(node, ctx) {
        // In a body cell, also inside a link or emphasis there.
        let inCell = false;
        for (
          let parent = ctx.parent(node);
          parent?.type === "element";
          parent = ctx.parent(parent)
        ) {
          if (parent.tagName === "td") {
            inCell = true;
            break;
          }
        }
        if (!inCell) {
          return;
        }
        const pieces = namePieces(ctx.textContent(node));
        if (pieces.length < 2) {
          return;
        }
        ctx.setField(
          node,
          "children",
          pieces.flatMap((piece, index): HastContent[] => [
            ...(index === 0
              ? []
              : [
                  {
                    type: "element" as const,
                    tagName: "wbr",
                    properties: {},
                    children: [],
                  },
                ]),
            { type: "text", value: piece },
          ])
        );
      },
    },
  ],
});
