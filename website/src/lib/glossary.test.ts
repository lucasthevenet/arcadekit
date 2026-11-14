import path from "node:path";
import { pathToFileURL } from "node:url";

import { markdownToHtml } from "satteri";
import { describe, expect, it } from "vitest";

import { createGlossaryPlugins } from "./glossary.ts";
import { REPO_ROOT } from "./site.ts";

const GLOSSARY = "CONTEXT.md";
const CORE = "packages/arcadekit/src/core/README.md";

/** Renders markdown as the page of a file of the repository, with the glossary's plugins. */
const render = async (markdown: string, file: string) => {
  const { terms, searchWeight } = createGlossaryPlugins({
    repoRoot: REPO_ROOT,
    glossary: GLOSSARY,
  });
  const { html } = await markdownToHtml(markdown, {
    mdastPlugins: [terms],
    hastPlugins: [searchWeight],
    fileURL: pathToFileURL(path.join(REPO_ROOT, file)),
  });
  return html;
};

const TERMS =
  "The words.\n\n**Step**: one `tick` of the simulation. A **sample** is not one.\n\n**Cue counter**: a running total.\n\nMessage is Foldkit's word.\n";

describe("the glossary", () => {
  it("has a heading for each term above its definition", async () => {
    const html = await render(TERMS, GLOSSARY);
    expect(html).toContain(
      '<h3>Step</h3>\n<p data-pagefind-weight="0.5">one <code>tick</code> of the simulation. A <strong>sample</strong> is not one.</p>'
    );
    expect(html).toContain(
      '<h3>Cue counter</h3>\n<p data-pagefind-weight="0.5">a running total.</p>'
    );
  });

  it("leaves a paragraph that doesn't start with a term as it is", async () => {
    const html = await render(TERMS, GLOSSARY);
    expect(html).toContain('<p data-pagefind-weight="0.5">The words.</p>');
    expect(html).toContain(
      `<p data-pagefind-weight="0.5">Message is Foldkit's word.</p>`
    );
    expect(html.match(/<h3/gu)).toHaveLength(2);
  });

  it("weighs its prose, not its terms, lower in a search", async () => {
    const html = await render(`${TERMS}\n- a list\n`, GLOSSARY);
    expect(html).toContain("<h3>Step</h3>");
    expect(html).toContain('<ul data-pagefind-weight="0.5">');
    // Inside a block, only the block has the weight.
    expect(html).toContain("<li>a list</li>");
  });

  it("is the only page whose paragraphs become headings", async () => {
    const html = await render(TERMS, CORE);
    expect(html).not.toContain("<h3");
    expect(html).not.toContain("data-pagefind-weight");
    expect(html).toContain("<p><strong>Step</strong>: one <code>tick</code>");
  });
});
