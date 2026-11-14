import path from "node:path";

import { createMarkdownRenderer } from "vitepress";
import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./pages.ts";
import { createReferencePlugin } from "./reference.ts";

const GLOSSARY = "CONTEXT.md";
const CORE = "packages/arcadekit/src/core/README.md";

/** Renders markdown as VitePress would render the page of a file of the repository. */
const render = async (markdown: string, file: string) => {
  const md = await createMarkdownRenderer(REPO_ROOT, {
    config: (renderer) => {
      renderer.use(
        createReferencePlugin({
          repoRoot: REPO_ROOT,
          glossary: GLOSSARY,
        })
      );
    },
  });
  return md.render(markdown, { path: path.join(REPO_ROOT, file) });
};

const TERMS =
  "# A glossary\n\nThe words.\n\n**Step**: one `tick` of the simulation. A **sample** is not one.\n\n**Cue counter**: a running total.\n\nMessage is Foldkit's word.\n";

describe("the glossary", () => {
  it("has a heading for each term, with an anchor, above its definition", async () => {
    const html = await render(TERMS, GLOSSARY);
    expect(html).toContain('<h3 id="step" tabindex="-1">Step <a');
    expect(html).toContain(
      "</h3>\n<p>one <code>tick</code> of the simulation. A <strong>sample</strong> is not one.</p>"
    );
    expect(html).toContain('<h3 id="cue-counter" tabindex="-1">Cue counter <a');
    expect(html).toContain("</h3>\n<p>a running total.</p>");
  });

  it("leaves a paragraph that doesn't start with a term as it is", async () => {
    const html = await render(TERMS, GLOSSARY);
    expect(html).toContain("<p>The words.</p>");
    expect(html).toContain("<p>Message is Foldkit's word.</p>");
    expect(html.match(/<h3/gu)).toHaveLength(2);
  });

  it("is the only page whose paragraphs become headings", async () => {
    const html = await render(TERMS, CORE);
    expect(html).not.toContain("<h3");
    expect(html).toContain("<p><strong>Step</strong>: one <code>tick</code>");
  });
});
