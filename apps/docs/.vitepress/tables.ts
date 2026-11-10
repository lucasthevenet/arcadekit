// Lets a path in a table's cell wrap, so a table fits a phone.
//
// The READMEs' tables hold names in code, such as `arcadekit/runtime/browser`. A browser never
// breaks one, so a column is as wide as its longest name, and on a phone the entries' table was
// nearly twice the page's width. Here a name in a cell may break after each slash: the browser
// takes the break only when the name doesn't fit its line, and a copied name has no mark of it.
// theme/custom.css does the rest.
import type { MarkdownRenderer } from "vitepress";

/** A name's pieces, between the places it may break: after each slash. */
export const namePieces = (name: string): string[] => name.split(/(?<=\/)/u);

export const tableNames = (md: MarkdownRenderer): void => {
  // Marks the inline code of each body cell: the renderer can't tell where a token is.
  md.core.ruler.push("table-names", (state) => {
    for (const [index, token] of state.tokens.entries()) {
      if (state.tokens[index - 1]?.type !== "td_open") {
        continue;
      }
      for (const child of token.children ?? []) {
        if (child.type === "code_inline") {
          child.meta = { ...child.meta, mayBreak: true };
        }
      }
    }
  });

  const render = md.renderer.rules.code_inline;
  md.renderer.rules.code_inline = (tokens, index, options, env, self) => {
    const token = tokens[index];
    if (token === undefined) {
      return "";
    }
    const mayBreak = token.meta?.mayBreak === true;
    if (!mayBreak && render !== undefined) {
      return render(tokens, index, options, env, self);
    }
    const name = (mayBreak ? namePieces(token.content) : [token.content])
      .map((piece) => md.utils.escapeHtml(piece))
      .join("<wbr>");
    return `<code${self.renderAttrs(token)}>${name}</code>`;
  };
};
