// The loader of Starlight's `docs` collection: the site's own pages, and the pages the site makes.
//
// Starlight serves the entries of its `docs` collection. Its own loader reads them from
// src/content/docs/: the landing page, the walkthrough, the concepts and the guides. This loader
// adds the reference: its index and each package's page, made from the packages' manifests
// (reference.ts), and each module's page, made from its doc comments (api.ts). Their markdown is
// rendered by the same Markdown processor as any other page (astro.config.ts), so the links and
// the tables get what the site adds to them.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { docsLoader } from "@astrojs/starlight/loaders";
import type { Loader, LoaderContext } from "astro/loaders";

import { readModule, renderModule } from "./api.ts";
import { discoverPages, firstParagraph } from "./pages.ts";
import type { LoadedPage, ModulePage, SitePages } from "./pages.ts";
import { renderIndex, renderPackage } from "./reference.ts";
import { BRANCH, REPO_ROOT, REPO_URL } from "./site.ts";

/**
 * Adds a page to the collection. `file` is what its edit link opens, and where its relative links
 * are read from; the reference's index, which no file writes, has no edit link.
 */
const store = async (context: LoaderContext, page: LoadedPage, edit = true) => {
  const absolute = path.join(REPO_ROOT, page.file);
  // Astro's paths of an entry's file are relative to the site's folder.
  const filePath = path.relative(fileURLToPath(context.config.root), absolute);
  const data = await context.parseData({
    id: page.slug,
    data: {
      title: page.title,
      ...(page.description === "" ? {} : { description: page.description }),
      // The file is outside the site's folder, where Starlight's own edit link would point.
      editUrl: edit ? `${REPO_URL}/edit/${BRANCH}/${page.file}` : false,
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

/** A module's page as a page of the repository: its doc comments, rendered as markdown. */
const modulePage = (page: ModulePage): LoadedPage => {
  const module = readModule(
    REPO_ROOT,
    `packages/${page.folder}`,
    page.packageName,
    page.name,
    page.file
  );
  return {
    ...page,
    title: page.name,
    description: firstParagraph(`# ${page.name}\n\n${module.comment}`),
    body: renderModule(module, REPO_URL, BRANCH),
  };
};

/** The reference's index: the packages, under their categories. */
const indexPage = (pages: SitePages): LoadedPage => ({
  ...pages.reference,
  title: "API Reference",
  description: "Every package of arcadekit, and each of its modules.",
  body: renderIndex(pages.packages),
});

export const pagesLoader = (): Loader => ({
  name: "arcadekit-pages",
  load: async (context) => {
    // Starlight's own loader first: it removes every entry it didn't load, these included.
    await docsLoader().load(context);
    const pages = discoverPages();
    await Promise.all([
      store(context, indexPage(pages), false),
      ...pages.packages.map((page) =>
        store(context, {
          ...page,
          body: renderPackage(page, REPO_URL, BRANCH),
        })
      ),
      ...pages.modules.map((page) => store(context, modulePage(page))),
    ]);
  },
});
