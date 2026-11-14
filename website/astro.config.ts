// The arcadekit docs site, https://arcadekit.dev (website/README.md).
//
// A Starlight site whose pages are the repository's own markdown, read in place: src/lib/pages.ts
// finds them, src/lib/loader.ts adds them to Starlight's `docs` collection, and src/lib/sidebar.ts
// groups them. As a page renders, the Markdown processor's plugins make the links the pages
// already have work here (links.ts), give the glossary's terms headings of their own
// (glossary.ts), let a table fit a phone (tables.ts), and leave out of the package's README what
// the landing page replaces (landing.ts). The build fails on a dead link (dead-links.ts).
import { satteri } from "@astrojs/markdown-satteri";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightSidebarTopics from "starlight-sidebar-topics";

import { deadLinks } from "./src/lib/dead-links.ts";
import { createGlossaryPlugins } from "./src/lib/glossary.ts";
import { createLandingPlugin } from "./src/lib/landing.ts";
import { createLinkRewriter } from "./src/lib/links.ts";
import { discoverPages, PACKAGE_README } from "./src/lib/pages.ts";
import { sidebarTopics } from "./src/lib/sidebar.ts";
import {
  BRANCH,
  NPM_URL,
  REPO_ROOT,
  REPO_URL,
  SITE_URL,
  WEBSITE_DIR,
} from "./src/lib/site.ts";
import { tableNames } from "./src/lib/tables.ts";

const DESCRIPTION =
  "Reusable primitives for building browser games with Effect, Foldkit and Three.js: a deterministic simulation core, a game loop and engine, input, content loading, saves, audio, pixel-art rendering and lockstep multiplayer.";

// The pages are found when this config is read: restart `astro dev` after adding one.
const pages = discoverPages();

const links = createLinkRewriter({
  repoRoot: REPO_ROOT,
  repoUrl: REPO_URL,
  branch: BRANCH,
  pageLinks: new Map([
    ...pages.all.flatMap((page) =>
      page.files.map((file) => [file, page.link] as const)
    ),
    // The package's README has no page of its own: the landing page includes it.
    [PACKAGE_README, pages.home.link],
  ]),
  onDeadLink: ({ href, file }) => {
    console.warn(`(!) Found dead link ${href} in ${file}`);
  },
});

const glossary = createGlossaryPlugins({
  repoRoot: REPO_ROOT,
  glossary: pages.glossary.file,
});

export default defineConfig({
  site: SITE_URL,
  // A page is a folder's `index.html`, `net/worker/index.html`, served at `/net/worker` with no
  // slash at its end (alchemy.run.ts), which its canonical link names.
  trailingSlash: "never",
  build: { format: "directory" },

  markdown: {
    processor: satteri({
      // In order: the glossary's terms become headings before the links plugin leaves the text
      // of every heading alone.
      mdastPlugins: [
        createLandingPlugin({ repoRoot: REPO_ROOT, readme: PACKAGE_README }),
        glossary.terms,
        links.plugin,
      ],
      hastPlugins: [glossary.searchWeight, tableNames],
    }),
  },

  integrations: [
    starlight({
      title: "arcadekit",
      description: DESCRIPTION,
      favicon: "/favicon.svg",
      head: [
        {
          tag: "link",
          attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
        },
        { tag: "meta", attrs: { name: "theme-color", content: "#090b0e" } },
        // The card a shared link shows (scripts/generate-images.mjs).
        {
          tag: "meta",
          attrs: { property: "og:image", content: `${SITE_URL}/og.png` },
        },
      ],
      social: [
        { icon: "github", label: "GitHub", href: REPO_URL },
        { icon: "npm", label: "npm", href: NPM_URL },
      ],
      // The landing page's file. The other pages' files are elsewhere in the repository, and
      // each names its own (loader.ts).
      editLink: { baseUrl: `${REPO_URL}/edit/${BRANCH}/${WEBSITE_DIR}/` },
      // Learn, Guides and Reference, each with a sidebar of its own (sidebar.ts).
      plugins: [starlightSidebarTopics(sidebarTopics(pages))],
      // The faces, self-hosted, then the site's look over Starlight's (styles/custom.css).
      customCss: [
        "@fontsource-variable/inter",
        "@fontsource/barlow-condensed/600.css",
        "@fontsource/barlow-condensed/700.css",
        "@fontsource/ibm-plex-mono/400.css",
        "@fontsource/ibm-plex-mono/600.css",
        "./src/styles/custom.css",
      ],
      // Code on the page's panels: one dark theme, square, in the monospace face.
      expressiveCode: {
        themes: ["vesper"],
        styleOverrides: {
          borderRadius: "2px",
          borderColor: "#2b2f32",
          codeBackground: "#11151a",
          codeFontFamily: "'IBM Plex Mono', ui-monospace, monospace",
          uiFontFamily: "'IBM Plex Mono', ui-monospace, monospace",
          frames: {
            editorTabBarBackground: "#0d1014",
            terminalTitlebarBackground: "#0d1014",
            terminalBackground: "#11151a",
            frameBoxShadowCssValue: "none",
          },
        },
      },
      components: {
        // The header's links: the package's version, and GRIMBONK.
        SocialIcons: "./src/components/social-icons.astro",
        // The look of polycombo.io (styles/custom.css): its wordmark, its hero, titles in
        // capitals, and one theme, dark.
        SiteTitle: "./src/components/site-title.astro",
        Hero: "./src/components/hero.astro",
        PageTitle: "./src/components/page-title.astro",
        ThemeProvider: "./src/components/theme-provider.astro",
        ThemeSelect: "./src/components/theme-select.astro",
      },
      markdown: {
        // Starlight's own transforms, such as a heading's anchor link, apply to the files under
        // these folders. The pages are files all over the repository.
        processedDirs: [".."],
      },
    }),
    deadLinks(links),
  ],
});
