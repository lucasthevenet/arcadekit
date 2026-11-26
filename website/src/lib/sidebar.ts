// The sidebar's topics, built from the pages found on disk: Learn, Guides and Reference, each with
// a sidebar of its own (starlight-sidebar-topics), as Effect's and Alchemy's docs are split.
//
// OUTLINE says which group each known page is in and in what order. It is not the list of pages:
// a page of src/content/docs/ it doesn't name is still listed, at the end of the group of its folder (a new
// concept at the end of Concepts, a new guide in Guides' "More"), and a package it doesn't name at
// the end of Packages. A name in it that is no page fails the build, so the outline can't keep a
// page that is gone.
import type { StarlightUserConfig } from "@astrojs/starlight/types";
import type { StarlightSidebarTopicsUserConfig } from "starlight-sidebar-topics";

import type { SitePages } from "./pages.ts";
import { moduleGroups } from "./reference.ts";
import { BRANCH, REPO_URL } from "./site.ts";

type Topic = StarlightSidebarTopicsUserConfig[number];
type SidebarItem = NonNullable<StarlightUserConfig["sidebar"]>[number];

/** A link to an address, such as the landing page or a folder on GitHub. */
interface Link {
  readonly label: string;
  readonly link: string;
}

/** A group of pages by their slug and links, in order, and of the groups inside it. */
export interface Group {
  readonly label: string;
  readonly items: readonly (string | Link | Group)[];
}

export type TopicId = "learn" | "guides" | "reference";

/**
 * Where the pages the outline doesn't name go: the group whose `section` is the folder of
 * src/content/docs/ they are in, or `"packages"` for a package's page.
 */
type Section = string;

const examples = (folder: string) =>
  `${REPO_URL}/tree/${BRANCH}/packages/${folder}`;

/** The groups of each topic, with the pages by their slug. */
export const OUTLINE: readonly (Group & {
  readonly topic: TopicId;
  readonly section?: Section;
})[] = [
  {
    topic: "learn",
    label: "Get started",
    section: "",
    items: [{ label: "Overview", link: "/" }, "making-a-game"],
  },
  {
    topic: "learn",
    label: "Concepts",
    section: "concepts",
    items: [
      "concepts/entities-and-systems",
      "concepts/ticks-and-frames",
      "concepts/determinism",
      "concepts/several-players",
    ],
  },
  {
    topic: "learn",
    label: "Examples",
    items: [
      { label: "A game in a page", link: examples("arcadekit/examples/page") },
      {
        label: "A real-time simulation",
        link: examples("arcadekit/examples/demo"),
      },
      {
        label: "A turn-based duel",
        link: `${REPO_URL}/blob/${BRANCH}/packages/arcadekit/examples/duel.ts`,
      },
      {
        label: "Ten thousand objects in Three.js",
        link: examples("three/examples/page"),
      },
    ],
  },
  {
    topic: "guides",
    label: "The simulation",
    items: [
      "guides/components",
      "guides/relations",
      "guides/transforms",
      "guides/queries",
      "guides/systems",
      "guides/events-and-actions",
      "guides/states",
      "guides/timers",
      "guides/overlaps",
      "guides/grids",
      "guides/plugins",
    ],
  },
  {
    topic: "guides",
    label: "In a page",
    items: [
      "guides/running-a-game",
      "guides/input",
      "guides/assets",
      "guides/sound",
      "guides/sound-in-a-page",
      "guides/ui",
      "guides/drawing-with-three",
      "guides/instances-and-objects",
      "guides/textures-and-models",
      "guides/between-two-ticks",
    ],
  },
  {
    topic: "guides",
    label: "Saves and replays",
    items: [
      "guides/saving-and-loading",
      "guides/migrating-saves",
      "guides/capturing-and-rewinding",
      "guides/replays",
    ],
  },
  {
    topic: "guides",
    label: "Several players",
    items: [
      "guides/sessions",
      "guides/detecting-drift",
      "guides/transports-and-relays",
      "guides/hosting-a-relay",
    ],
  },
  {
    topic: "guides",
    label: "Testing",
    items: ["guides/testing", "guides/testing-peers"],
  },
  { topic: "guides", label: "Debugging", items: ["guides/debugging"] },
  {
    topic: "guides",
    label: "Performance",
    items: ["guides/performance", "guides/drawing-performance"],
  },
  { topic: "guides", label: "More", section: "guides", items: [] },
  {
    topic: "reference",
    // A group for each package, with its page and its modules (packageGroups).
    label: "Packages",
    section: "packages",
    items: ["reference/arcadekit", "reference/three"],
  },
];

/** The section a page belongs to when the outline doesn't name it. */
const sectionOf = (pages: SitePages, slug: string): Section | undefined => {
  if (pages.packages.some((page) => page.slug === slug)) {
    return "packages";
  }
  return pages.docs.find((page) => page.slug === slug)?.section;
};

/**
 * The groups of every topic: the outline's own order, then each page it doesn't name at the end
 * of its section's group, by path. A page of a folder no group has goes in Get started. A group
 * left with no page is left out.
 */
export const outlinedGroups = (
  pages: SitePages
): (Group & { readonly topic: TopicId })[] => {
  const slugs = [...pages.docs, ...pages.packages].map((page) => page.slug);
  const named = new Set(
    OUTLINE.flatMap((group) =>
      group.items.filter((item) => typeof item === "string")
    )
  );
  const missing = [...named].filter((slug) => !slugs.includes(slug));
  if (missing.length > 0) {
    throw new Error(
      `website/src/lib/sidebar.ts lists ${missing.join(", ")}, which no page is`
    );
  }
  const sections = new Set(OUTLINE.map((group) => group.section));
  const rest = (section: Section | undefined) =>
    section === undefined
      ? []
      : slugs.filter((slug) => {
          if (named.has(slug)) {
            return false;
          }
          const own = sectionOf(pages, slug);
          return own === section || (section === "" && !sections.has(own));
        });
  return OUTLINE.map(({ section, ...group }) => ({
    ...group,
    section,
    items: [...group.items, ...rest(section)],
  }))
    .flatMap(({ section, ...group }) =>
      section === "packages" ? packageGroups(pages, group) : [group]
    )
    .filter((group) => group.items.length > 0);
};

/**
 * The packages' group as a group for each package, named after it: its page, which lists its
 * modules, then a page for each of them, in a group for each of its groups when it has some
 * (moduleGroups).
 */
const packageGroups = (
  pages: SitePages,
  group: Group & { readonly topic: TopicId }
): (Group & { readonly topic: TopicId })[] =>
  group.items.flatMap((item) => {
    const page = pages.packages.find((p) => p.slug === item);
    if (page === undefined) {
      return [];
    }
    return [
      {
        topic: group.topic,
        label: page.title,
        items: [
          { label: "Overview", link: page.link },
          ...moduleGroups(page).flatMap(
            ({ label, modules }): (string | Group)[] => {
              const slugs = modules.map((name) => `${page.slug}/${name}`);
              return label === undefined ? slugs : [{ label, items: slugs }];
            }
          ),
        ],
      },
    ];
  });

const toItem = (item: string | Link | Group): SidebarItem => {
  if (typeof item === "string") {
    return item;
  }
  return "link" in item
    ? { label: item.label, link: item.link }
    : { label: item.label, items: item.items.map(toItem) };
};

/** The Learn, Guides and Reference topics, each linking to its first page. */
export const sidebarTopics = (pages: SitePages): Topic[] => {
  const groups = outlinedGroups(pages);
  const topic = (id: TopicId) =>
    groups
      .filter((group) => group.topic === id)
      .map(({ label, items }) => ({ label, items: items.map(toItem) }));
  return [
    {
      id: "learn",
      label: "Learn",
      link: "/making-a-game",
      icon: "rocket",
      items: topic("learn"),
    },
    {
      id: "guides",
      label: "Guides",
      link: "/guides/components",
      icon: "open-book",
      items: topic("guides"),
    },
    {
      id: "reference",
      label: "Reference",
      link: "/reference",
      icon: "document",
      items: [
        { label: "API Reference", link: "/reference" },
        ...topic("reference"),
      ],
    },
  ];
};
