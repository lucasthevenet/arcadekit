import { i18nLoader } from "@astrojs/starlight/loaders";
// Starlight's collections:
// - `docs`, the pages: the landing page, under content/docs/, and the repository's markdown,
//   read where it is (lib/loader.ts);
// - `i18n`, the site's own words where they replace Starlight's, such as the 404 page's text.
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro:content";

import { pagesLoader } from "./lib/loader.ts";

export const collections = {
  docs: defineCollection({ loader: pagesLoader(), schema: docsSchema() }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
