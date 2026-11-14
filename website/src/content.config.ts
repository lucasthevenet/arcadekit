import { i18nLoader } from "@astrojs/starlight/loaders";
// Starlight's collections:
// - `docs`, the pages: the landing page, under content/docs/, and the repository's markdown,
//   read where it is (lib/loader.ts);
// - `i18n`, the site's own words where they replace Starlight's, such as the 404 page's text.
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";
import { z } from "astro/zod";
import { defineCollection } from "astro:content";

import { pagesLoader } from "./lib/loader.ts";

export const collections = {
  docs: defineCollection({
    loader: pagesLoader(),
    // `eyebrow`: the line in the monospace face over the landing page's title
    // (components/hero.astro). `api`: what a reference page documents (lib/loader.ts).
    schema: docsSchema({
      extend: z.object({
        eyebrow: z.string().optional(),
        api: z
          .object({
            kind: z.enum(["entry", "module"]),
            exports: z.number().int(),
          })
          .optional(),
      }),
    }),
  }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
