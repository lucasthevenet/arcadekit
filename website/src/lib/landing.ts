// What the landing page takes from the package's README.
//
// The landing page (src/content/docs/index.mdx) includes the package's README, which has no page
// of its own. The landing page's hero and first paragraph take the place of the README's title
// and first paragraph, so this plugin leaves those two out wherever the README is rendered. The
// rest, from its status line on, is the landing page's: how to install the package, and its
// entries.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineMdastPlugin } from "satteri";
import type { MdastPluginDefinition, PluginFactoryContext } from "satteri";

export interface LandingOptions {
  /** The repository's root on disk. */
  readonly repoRoot: string;
  /** The package's README, relative to the repository's root. */
  readonly readme: string;
}

export const createLandingPlugin = (options: LandingOptions) => {
  const readme = path.join(options.repoRoot, options.readme);
  return (context: PluginFactoryContext): MdastPluginDefinition | null =>
    context.fileURL !== undefined && fileURLToPath(context.fileURL) === readme
      ? defineMdastPlugin({
          name: "arcadekit:landing-readme",
          before(root, ctx) {
            const [title, paragraph] = root.children;
            if (
              title?.type !== "heading" ||
              title.depth !== 1 ||
              paragraph?.type !== "paragraph"
            ) {
              throw new Error(
                `The landing page includes ${options.readme} after its title and its first paragraph, which its hero replaces. The README no longer starts with a "# " heading and a paragraph: change website/src/lib/landing.ts to match it.`
              );
            }
            ctx.removeNode(title);
            ctx.removeNode(paragraph);
          },
        })
      : null;
};
