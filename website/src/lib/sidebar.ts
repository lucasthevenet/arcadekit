// The sidebar, built from the pages found on disk.
//
// OUTLINE says which group each known page is in and in what order: the guides and concepts of
// `docs/` by their slug, the entries by their folder under `src/`. It is not the list of pages: a
// page it doesn't name is still listed, at the end of the group of its folder (a new guide at the
// end of Guides, a new concept at the end of Concepts), and a new entry at the end of Reference.
// A name in it that is no page fails the build, so the outline can't keep a page that is gone.
import type { StarlightUserConfig } from "@astrojs/starlight/types";

import type { DocPage, EntryPage, SitePages } from "./pages.ts";
import { BRANCH, GRIMBONK_URL, REPO_URL } from "./site.ts";

type SidebarItem = NonNullable<StarlightUserConfig["sidebar"]>[number];

/** A link to an address, such as a heading of the landing page. */
interface Link {
  readonly label: string;
  readonly link: string;
}

/** A group of pages by their slug, links and groups, in order. */
interface Group {
  readonly label: string;
  readonly items: readonly (string | Link | Group)[];
  /** Shut until opened, unless it holds the page being read. */
  readonly collapsed?: boolean;
}

/** The guides and concepts, by their slug, and where a page the outline doesn't name goes. */
const OUTLINE: readonly (Group & { readonly section: string })[] = [
  {
    label: "Get started",
    section: "",
    items: [
      { label: "Overview", link: "/" },
      { label: "Install", link: "/#install" },
      "making-a-game",
    ],
  },
  {
    label: "Concepts",
    section: "concepts",
    items: [
      "concepts/declarations",
      "concepts/steps-and-frames",
      "concepts/determinism",
      "concepts/lockstep",
    ],
  },
  {
    label: "Guides",
    section: "guides",
    items: [
      {
        label: "The rules",
        collapsed: true,
        items: [
          "guides/simulation",
          "guides/commands",
          "guides/several-players",
        ],
      },
      {
        label: "The world",
        collapsed: true,
        items: [
          "guides/entity-pools",
          "guides/spatial-grid",
          "guides/tile-maps",
          "guides/timers-and-tweens",
          "guides/rings",
        ],
      },
      {
        label: "In the browser",
        collapsed: true,
        items: [
          "guides/engine",
          "guides/input",
          "guides/content",
          "guides/saves",
          "guides/foldkit",
        ],
      },
      {
        label: "Drawing and sound",
        collapsed: true,
        items: [
          "guides/stages-and-cameras",
          "guides/sprites",
          "guides/tile-layers",
          "guides/mesh-instances",
          "guides/audio",
        ],
      },
      {
        label: "Co-op",
        collapsed: true,
        items: [
          "guides/lockstep-sessions",
          "guides/webrtc",
          "guides/coop",
          "guides/signalling-worker",
        ],
      },
    ],
  },
  {
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

/** The entries' top folders under `src/`, in the order Reference lists them. */
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
    return "items" in item ? slugsOf(item.items) : [];
  });

/**
 * The guides and concepts by group: the outline's own order, then each page it doesn't name at
 * the end of its folder's group, by path. A page of a folder no group has goes in Get started.
 */
export const outlinedDocs = (docs: readonly DocPage[]): Group[] => {
  const slugs = new Set(docs.map((page) => page.slug));
  const named = new Set(OUTLINE.flatMap((group) => slugsOf(group.items)));
  const missing = [...named].filter((slug) => !slugs.has(slug));
  if (missing.length > 0) {
    throw new Error(
      `website/src/lib/sidebar.ts lists ${missing.join(", ")}, which no file under docs/ is`
    );
  }
  const sections = new Set(OUTLINE.map((group) => group.section));
  const rest = (section: string) =>
    docs
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
  }));
};

const topFolder = (page: EntryPage) => page.entry.split("/", 1)[0] ?? "";

/** Where an entry is in Reference: its top folder's place in the order, or after them all. */
const rankOf = (page: EntryPage) => {
  const at = ENTRY_ORDER.indexOf(topFolder(page));
  return at === -1 ? ENTRY_ORDER.length : at;
};

/**
 * The entries in Reference's order: the known top folders in theirs, then any other by path, each
 * with its sub-entries after it, so `net/worker` follows `net`.
 */
export const orderedEntries = (entries: readonly EntryPage[]): EntryPage[] =>
  entries.toSorted(
    (a, b) => rankOf(a) - rankOf(b) || a.entry.localeCompare(b.entry)
  );

const toItem = (item: string | Link | Group): SidebarItem => {
  if (typeof item === "string") {
    return item;
  }
  if (!("items" in item)) {
    return { label: item.label, link: item.link };
  }
  return {
    label: item.label,
    items: item.items.map(toItem),
    ...(item.collapsed === true ? { collapsed: true } : {}),
  };
};

/**
 * Starlight's sidebar: Get started, the concepts, the guides, testing, the reference pages with
 * the glossary, and the games built on the kit. A page is named by its slug, and Starlight labels
 * it with its title: a guide's heading, an entry's import path.
 */
export const sidebar = (pages: SitePages): SidebarItem[] => [
  ...outlinedDocs(pages.docs).map(toItem),
  {
    label: "Reference",
    items: [
      ...orderedEntries(pages.entries).map((page) => page.slug),
      pages.glossary.slug,
    ],
  },
  {
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
];
