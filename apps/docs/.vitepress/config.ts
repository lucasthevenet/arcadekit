// The arcadekit docs site, https://arcadekit.dev (apps/docs/README.md).
//
// Its pages are the repository's own markdown, read in place: `srcDir` is the repository's root,
// `rewrites` gives each page its address, and `srcExclude` leaves every other markdown file out.
// pages.ts finds the pages, sidebar.ts groups them, links.ts makes the links the READMEs
// already have work here, reference.ts gives the glossary and the decisions what a page needs,
// and version.ts says which version the pages describe.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { defineConfig } from "vitepress";
import type { HeadConfig } from "vitepress";

import { createLinkRewriter, whereIs } from "./links.ts";
import {
  discoverPages,
  entryRedirects,
  markdownThatIsNotAPage,
  PACKAGE_README,
  REPO_ROOT,
} from "./pages.ts";
import { createReferencePlugin } from "./reference.ts";
import { entriesNav, sidebar } from "./sidebar.ts";
import { packageVersion, versionLabel } from "./version.ts";

/** Where the site is served: its canonical address, with no trailing slash. */
const SITE_URL = "https://arcadekit.dev";
const REPO_URL = "https://github.com/lucasthevenet/arcadekit";
const BRANCH = "main";
const GRIMBONK_URL = "https://grimbonk.arcadekit.dev";
const DESCRIPTION =
  "Reusable primitives for building browser games with Effect, Foldkit and Three.js: a deterministic simulation core, a game loop and engine, input, content loading, saves, audio, pixel-art rendering and lockstep multiplayer.";

const DOCS_DIR = path.resolve(import.meta.dirname, "..");
/** A file of VitePress's own, to resolve `vue` from where VitePress does. */
const VITEPRESS = createRequire(import.meta.url).resolve("vitepress");

const pages = discoverPages();
const servedAs = new Map(pages.all.map((page) => [page.file, page.servedAs]));
const pageByFile = new Map(pages.all.map((page) => [page.file, page]));
const adrByFile = new Map(pages.adrs.map((page) => [page.file, page]));

const links = createLinkRewriter({
  repoRoot: REPO_ROOT,
  repoUrl: REPO_URL,
  branch: BRANCH,
  pageLinks: new Map([
    ...pages.all.map((page) => [page.file, page.link] as const),
    // The package's README has no page of its own: the landing page includes it.
    [PACKAGE_README, pages.home.link],
  ]),
  // The landing page includes the package's README, whose links start from its own folder.
  includes: new Map([[pages.home.file, PACKAGE_README]]),
  onDeadLink: (link) => {
    console.warn(`(!) Found dead link ${link.href} in file ${whereIs(link)}`);
  },
});

const reference = createReferencePlugin({
  repoRoot: REPO_ROOT,
  glossary: pages.glossary.file,
  adrs: adrByFile,
});

const { version, unreleased } = packageVersion(REPO_ROOT);

export default defineConfig({
  srcDir: REPO_ROOT,
  srcExclude: markdownThatIsNotAPage(pages),
  // The pages are found when this config is read: restart `vitepress dev` after adding one.
  rewrites: (file) => servedAs.get(file) ?? file,
  outDir: "dist",

  lang: "en",
  title: "arcadekit",
  description: DESCRIPTION,
  cleanUrls: true,
  sitemap: { hostname: SITE_URL },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["link", { rel: "apple-touch-icon", href: "/apple-touch-icon.png" }],
    ["meta", { name: "theme-color", content: "#17151f" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "arcadekit" }],
    ["meta", { property: "og:image", content: `${SITE_URL}/og.png` }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
  ],

  markdown: {
    config: (md) => {
      md.use(reference);
      md.use(links.plugin);
    },
  },

  // An entry with no README has no page: Cloudflare sends its address to the page that
  // documents it (pages.ts), with or without a slash at its end, as it serves a page. A 302, not
  // a 301 a browser would remember, since the entry's own README would take the address over.
  // Neither VitePress's dev server nor its preview reads `_redirects`: `alchemy dev` does.
  buildEnd: (siteConfig) => {
    writeFileSync(
      path.join(siteConfig.outDir, "_redirects"),
      entryRedirects(pages)
        .map(({ from, to }) => `${from} ${to} 302\n${from}/ ${to} 302\n`)
        .join("")
    );
  },

  // Each page's address and description: the canonical link and the tags a shared link shows.
  transformPageData: (pageData) => {
    const page = pageByFile.get(pageData.filePath);
    const adr = adrByFile.get(pageData.filePath);
    const title =
      adr === undefined ? pageData.title : `ADR-${adr.number}: ${adr.title}`;
    const description =
      pageData.description || page?.description || DESCRIPTION;
    const url = `${SITE_URL}${page?.link ?? `/${pageData.relativePath.replace(/\.md$/u, "")}`}`;
    const head: HeadConfig[] = [
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:url", content: url }],
      [
        "meta",
        {
          property: "og:title",
          content: pageData.frontmatter.layout === "home" ? "arcadekit" : title,
        },
      ],
      ["meta", { property: "og:description", content: description }],
    ];
    return {
      title,
      description,
      frontmatter: {
        ...pageData.frontmatter,
        head: [...(pageData.frontmatter.head ?? []), ...head],
      },
    };
  },

  vite: {
    // The site's static files. Vite would look for them in `srcDir`, the repository's root.
    publicDir: path.join(DOCS_DIR, "public"),
    // Vite's root is the repository, so it would scan the demos' index.html for dependencies.
    optimizeDeps: { entries: [] },
    plugins: [
      {
        // A page compiles to a Vue component that imports `vue`. Node resolves an import from
        // the importing file's folder upwards, and the pages are files all over the repository,
        // where pnpm installs no `vue`: only VitePress has it. So resolve it as VitePress's own
        // code does, which also keeps the site on one copy of Vue.
        name: "arcadekit-docs:vue-from-vitepress",
        enforce: "pre",
        resolveId(source, importer, options) {
          if (
            (source === "vue" || source.startsWith("vue/")) &&
            importer !== undefined &&
            !importer.includes("/node_modules/")
          ) {
            return this.resolve(source, VITEPRESS, {
              ...options,
              skipSelf: true,
            });
          }
          return null;
        },
      },
      {
        name: "arcadekit-docs:dead-repository-links",
        // VitePress fails the build on a dead link between pages. This does the same for the
        // links that leave the site for GitHub: each must name a file or folder of the
        // repository (links.ts).
        buildEnd() {
          const dead = links.deadLinks();
          if (dead.length > 0) {
            throw new Error(
              [
                `${dead.length} dead link(s) to files of the repository:`,
                ...dead.map((link) => `  ${link.href} in ${whereIs(link)}`),
              ].join("\n")
            );
          }
        },
      },
    ],
  },

  themeConfig: {
    logo: { src: "/favicon.svg", alt: "" },
    nav: [
      { text: "Entries", items: entriesNav(pages) },
      {
        text: "Reference",
        activeMatch: "^/(?:glossary|adr)",
        items: [
          { text: "Glossary", link: pages.glossary.link },
          {
            text: "Decisions",
            link: pages.adrIndex.link,
            activeMatch: "^/adr",
          },
        ],
      },
      { text: "GRIMBONK", link: GRIMBONK_URL },
      {
        // The pages follow `main`, which may be ahead of the package on npm (version.ts).
        text: versionLabel(version, unreleased),
        items: [
          ...(unreleased
            ? [
                {
                  text: "Unreleased changes",
                  link: `${REPO_URL}/tree/${BRANCH}/.changeset`,
                },
              ]
            : []),
          {
            text: "Changelog",
            link: `${REPO_URL}/blob/${BRANCH}/packages/arcadekit/CHANGELOG.md`,
          },
          { text: "npm", link: "https://www.npmjs.com/package/arcadekit" },
        ],
      },
    ],
    sidebar: sidebar(pages),
    outline: { level: [2, 3] },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: REPO_URL }],
    editLink: {
      pattern: `${REPO_URL}/edit/${BRANCH}/:path`,
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Released under the MIT License.",
    },
    notFound: {
      title: "Page not found",
      quote: "No page has this address. The landing page lists every entry.",
      linkText: "Go to the landing page",
      linkLabel: "Go to the landing page",
    },
  },
});
