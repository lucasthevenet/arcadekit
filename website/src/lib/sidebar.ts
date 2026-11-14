// The sidebar's topics, built from the pages found on disk: Learn, Guides and Reference, each with
// a sidebar of its own (starlight-sidebar-topics), as Effect's and Alchemy's docs are split.
//
// OUTLINE says which group each known page of `docs/` is in and in what order. It is not the list
// of pages: a page it doesn't name is still listed, at the end of the group of its folder (a new
// concept at the end of Concepts, a new guide in Guides' "More"). A name in it that is no page
// fails the build, so the outline can't keep a page that is gone. Reference lists every entry of
// the package, with its modules, from the pages pages.ts made of them.
import type { StarlightUserConfig } from "@astrojs/starlight/types";
import type { StarlightSidebarTopicsUserConfig } from "starlight-sidebar-topics";

import type { DocPage, EntryPage, ModulePage, SitePages } from "./pages.ts";
import { BRANCH, GRIMBONK_URL, REPO_URL } from "./site.ts";

type Topic = StarlightSidebarTopicsUserConfig[number];
type SidebarItem = NonNullable<StarlightUserConfig["sidebar"]>[number];

/** A link to an address, such as a heading of the landing page or another site. */
interface Link {
  readonly label: string;
  readonly link: string;
}

/** A page by its slug, under another label than its title. */
interface Labelled {
  readonly label: string;
  readonly slug: string;
}

/** A group of pages by their slug, links and groups, in order. */
interface Group {
  readonly label: string;
  readonly items: readonly (string | Link | Labelled | Group)[];
  /** Shut until opened, unless it holds the page being read. */
  readonly collapsed?: boolean;
}

type TopicId = "learn" | "guides";

/**
 * The groups of the Learn and Guides topics, with the guides and concepts by their slug. A
 * `section` is the folder of `docs/` whose pages the outline doesn't name go at the group's end.
 */
const OUTLINE: readonly (Group & {
  readonly topic: TopicId;
  readonly section?: string;
})[] = [
  {
    topic: "learn",
    label: "Get started",
    section: "",
    items: [
      { label: "Overview", link: "/" },
      { label: "Install", link: "/reference#install" },
      "making-a-game",
    ],
  },
  {
    topic: "learn",
    label: "Concepts",
    section: "concepts",
    items: [
      "concepts/domain-driven-design",
      "concepts/declarations",
      "concepts/steps-and-frames",
      "concepts/determinism",
      "concepts/lockstep",
    ],
  },
  {
    topic: "learn",
    label: "Examples",
    items: [
      { label: "GRIMBONK", link: GRIMBONK_URL },
      {
        label: "The survivors demo",
        link: `${REPO_URL}/tree/${BRANCH}/examples/survivor-demo`,
      },
      {
        label: "The push-puzzle demo",
        link: `${REPO_URL}/tree/${BRANCH}/examples/push-puzzle-demo`,
      },
    ],
  },
  {
    topic: "guides",
    label: "The rules",
    items: ["guides/simulation", "guides/commands", "guides/several-players"],
  },
  {
    topic: "guides",
    label: "The world",
    items: [
      "guides/entity-pools",
      "guides/spatial-grid",
      "guides/tile-maps",
      "guides/timers-and-tweens",
      "guides/rings",
    ],
  },
  {
    topic: "guides",
    label: "In the browser",
    items: [
      "guides/engine",
      "guides/input",
      "guides/content",
      "guides/saves",
      "guides/foldkit",
    ],
  },
  {
    topic: "guides",
    label: "Drawing and sound",
    items: [
      "guides/stages-and-cameras",
      "guides/sprites",
      "guides/tile-layers",
      "guides/mesh-instances",
      "guides/audio",
    ],
  },
  {
    topic: "guides",
    label: "Co-op",
    items: [
      "guides/lockstep-sessions",
      "guides/webrtc",
      "guides/coop",
      "guides/signalling-worker",
    ],
  },
  { topic: "guides", label: "More", section: "guides", items: [] },
  {
    topic: "guides",
    label: "Testing",
    section: "testing",
    items: [
      "testing/scenarios",
      "testing/engines",
      "testing/views",
      "testing/coop",
    ],
  },
];

/** The top-level entries, in the order Reference lists them. Any other follows, by path. */
const ENTRY_ORDER = [
  "game",
  "core",
  "input",
  "content",
  "save",
  "audio",
  "render-three",
  "foldkit",
  "net",
];

const slugsOf = (items: Group["items"]): string[] =>
  items.flatMap((item) => {
    if (typeof item === "string") {
      return [item];
    }
    if ("items" in item) {
      return slugsOf(item.items);
    }
    return "slug" in item ? [item.slug] : [];
  });

/**
 * The groups of the Learn and Guides topics: the outline's own order, then each page it doesn't
 * name at the end of its folder's group, by path. A page of a folder no group has goes in Get
 * started. A group left with no page is left out.
 */
export const outlinedDocs = (
  docs: readonly DocPage[]
): (Group & { readonly topic: TopicId })[] => {
  const slugs = new Set(docs.map((page) => page.slug));
  const named = new Set(OUTLINE.flatMap((group) => slugsOf(group.items)));
  const missing = [...named].filter((slug) => !slugs.has(slug));
  if (missing.length > 0) {
    throw new Error(
      `website/src/lib/sidebar.ts lists ${missing.join(", ")}, which no file under docs/ is`
    );
  }
  const sections = new Set(OUTLINE.map((group) => group.section));
  const rest = (section: string | undefined) =>
    section === undefined
      ? []
      : docs
          .filter(
            (page) =>
              !named.has(page.slug) &&
              (page.section === section ||
                (section === "" && !sections.has(page.section)))
          )
          .map((page) => page.slug);
  return OUTLINE.map(({ section, ...group }) => ({
    ...group,
    items: [...group.items, ...rest(section)],
  })).filter((group) => group.items.length > 0);
};

const topFolder = (entry: string) => entry.split("/", 1)[0] ?? "";

/** Where an entry is in Reference: its top folder's place in the order, or after them all. */
const rankOf = (entry: string) => {
  const at = ENTRY_ORDER.indexOf(topFolder(entry));
  return at === -1 ? ENTRY_ORDER.length : at;
};

/**
 * The entries in Reference's order: the known top folders in theirs, then any other by path, each
 * with its sub-entries after it, so `net/worker` follows `net`.
 */
export const orderedEntries = (entries: readonly EntryPage[]): EntryPage[] =>
  entries.toSorted(
    (a, b) =>
      rankOf(a.entry) - rankOf(b.entry) || a.entry.localeCompare(b.entry)
  );

/** An entry's page, then its modules' by name. */
const entryItems = (
  entry: EntryPage,
  modules: readonly ModulePage[]
): Group["items"] => [
  { label: "Overview", slug: entry.slug },
  ...modules
    .filter((module) => module.entry === entry.entry)
    .toSorted((a, b) => a.module.localeCompare(b.module))
    .map((module) => module.slug),
];

/**
 * Reference's groups: the package's page, how to install it and its entries, then one for each
 * top-level entry, shut until opened, with its page, its modules, and each sub-entry: one page
 * alone, or a group of it and its modules. Then the glossary.
 */
export const referenceGroups = (pages: SitePages): Group["items"] => {
  const entries = orderedEntries(pages.entries);
  return [
    { label: "The package", slug: pages.kit.slug },
    ...entries
      .filter((page) => !page.entry.includes("/"))
      .map((top) => ({
        label: top.title,
        collapsed: true,
        items: [
          ...entryItems(top, pages.modules),
          ...entries
            .filter((page) => page.entry.startsWith(`${top.entry}/`))
            .map((sub) => {
              const items = entryItems(sub, pages.modules);
              return items.length === 1
                ? sub.slug
                : { label: sub.title, collapsed: true, items };
            }),
        ],
      })),
    pages.glossary.slug,
  ];
};

const toItem = (item: string | Link | Labelled | Group): SidebarItem => {
  if (typeof item === "string") {
    return item;
  }
  if ("items" in item) {
    return {
      label: item.label,
      items: item.items.map(toItem),
      ...(item.collapsed === true ? { collapsed: true } : {}),
    };
  }
  return "slug" in item
    ? { label: item.label, slug: item.slug }
    : { label: item.label, link: item.link };
};

/** The Learn, Guides and Reference topics, each linking to its first page. */
export const sidebarTopics = (pages: SitePages): Topic[] => {
  const groups = outlinedDocs(pages.docs);
  const topic = (id: TopicId) =>
    groups
      .filter((group) => group.topic === id)
      .map(({ topic: _topic, ...group }) => toItem(group));
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
      link: "/guides/simulation",
      icon: "open-book",
      items: topic("guides"),
    },
    {
      id: "reference",
      label: "Reference",
      link: "/reference",
      icon: "document",
      items: referenceGroups(pages).map(toItem),
    },
  ];
};
