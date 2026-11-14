import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { markdownToHtml } from "satteri";
import { describe, expect, it } from "vitest";

import { createLandingPlugin } from "./landing.ts";
import { REPO_ROOT } from "./site.ts";

const README = "packages/arcadekit/README.md";

const render = async (markdown: string, file: string) => {
  const { html } = await markdownToHtml(markdown, {
    mdastPlugins: [
      createLandingPlugin({ repoRoot: REPO_ROOT, readme: README }),
    ],
    fileURL: pathToFileURL(path.join(REPO_ROOT, file)),
  });
  return html;
};

describe("the package's README on the landing page", () => {
  it("leaves out the title and the first paragraph, which the hero replaces", async () => {
    const html = await render(
      "# arcadekit\n\nReusable primitives.\n\n**Status: alpha.**\n\n## Install\n",
      README
    );
    expect(html).toBe(
      "<p><strong>Status: alpha.</strong></p>\n<h2>Install</h2>\n"
    );
  });

  it("fails when the README no longer starts that way", async () => {
    await expect(
      render("Reusable primitives.\n\n## Install\n", README)
    ).rejects.toThrow('no longer starts with a "# " heading and a paragraph');
  });

  it("leaves any other file as it is", async () => {
    await expect(
      render(
        "# arcadekit/core\n\nThe core.\n",
        "packages/arcadekit/src/core/README.md"
      )
    ).resolves.toBe("<h1>arcadekit/core</h1>\n<p>The core.</p>\n");
  });

  it("has a README that starts that way, with the heading the hero's button goes to", async () => {
    const html = await render(
      readFileSync(path.join(REPO_ROOT, README), "utf-8"),
      README
    );
    expect(html).not.toContain("<h1>");
    expect(html).toContain("<h2>Install</h2>");
  });
});
