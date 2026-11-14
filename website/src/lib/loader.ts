import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The loader of Starlight's `docs` collection: the site's own pages, and the repository's
// markdown, read where it is.
//
// Starlight serves the entries of its `docs` collection. Its own loader reads them from
// src/content/docs/, which holds the landing page alone. This loader adds each file of the
// repository pages.ts names as an entry: the file stays where GitHub and npm read it, and no
// copy is made, so there is one text to keep right.
//
// Starlight writes a page's title from its frontmatter, and the files have none: a file's title is
// its first line, the `# ` heading. So the entry's title is that heading, its description the file's
// first paragraph, and its content the rest of the file, rendered by the same Markdown processor
// as any other page (astro.config.ts), so the links, the glossary and the tables get what the
// site adds to them.
import { docsLoader } from "@astrojs/starlight/loaders";
import type { Loader, LoaderContext } from "astro/loaders";

import { discoverPages } from "./pages.ts";
import type { RepositoryPage } from "./pages.ts";
import { BRANCH, REPO_ROOT, REPO_URL } from "./site.ts";

/** The package's source, whose doc comments are the reference's text. */
const KIT_SOURCES = "packages/arcadekit/src";

/** The sidebar's label for a page whose title is too long for it. */
const SIDEBAR_LABELS: Readonly<Record<string, string>> = {
  glossary: "Glossary",
};

/** Adds a page of the repository to the collection, rendered as it is now on disk. */
const store = async (context: LoaderContext, page: RepositoryPage) => {
  const absolute = path.join(REPO_ROOT, page.file);
  // Astro's paths of an entry's file are relative to the site's folder.
  const filePath = path.relative(fileURLToPath(context.config.root), absolute);
  const label = SIDEBAR_LABELS[page.slug];
  const data = await context.parseData({
    id: page.slug,
    data: {
      title: page.title,
      ...(page.description === "" ? {} : { description: page.description }),
      // The file is outside the site's folder, where Starlight's own edit link would point.
      editUrl: `${REPO_URL}/edit/${BRANCH}/${page.file}`,
      ...(label === undefined ? {} : { sidebar: { label } }),
    },
    filePath,
  });
  context.store.set({
    id: page.slug,
    data,
    body: page.body,
    filePath,
    // Rendered on every load, with no digest to skip it: a page renders the same text
    // differently when a file it links to comes or goes, and the build must see that dead link.
    rendered: await context.renderMarkdown(page.body, {
      fileURL: pathToFileURL(absolute),
    }),
  });
};

export const pagesLoader = (): Loader => ({
  name: "arcadekit-pages",
  load: async (context) => {
    // Starlight's own loader first: it removes every entry it didn't load, these included.
    await docsLoader().load(context);
    const pages = discoverPages();
    await Promise.all(pages.repository.map((page) => store(context, page)));

    // `astro dev` reloads a page as a file it is made from changes: a page of `docs/`, a README,
    // the glossary, or a source file of the package, whose doc comments are the reference's. The
    // pages are read again, and each whose text changed is stored again. A new page is found
    // when the site starts: restart `pnpm dev:docs` after adding one.
    const bodies = new Map(
      pages.repository.map((page) => [page.slug, page.body])
    );
    context.watcher?.add([
      ...pages.repository.map((page) => path.join(REPO_ROOT, page.file)),
      path.join(REPO_ROOT, KIT_SOURCES),
    ]);
    context.watcher?.on("change", (changed) => {
      const file = path.relative(REPO_ROOT, path.resolve(changed));
      if (file.startsWith("..") || !/\.(?:md|ts)$/u.test(file)) {
        return;
      }
      try {
        for (const page of discoverPages().repository) {
          if (bodies.get(page.slug) !== page.body) {
            bodies.set(page.slug, page.body);
            store(context, page).catch((error: unknown) => {
              context.logger.error(String(error));
            });
          }
        }
      } catch (error) {
        // A file mid-edit that doesn't parse: the next save reads it again.
        context.logger.error(String(error));
      }
    });
  },
});
