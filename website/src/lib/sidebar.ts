// The sidebar, built from the pages found on disk.
//
// GROUPS says which group a known entry is in and in what order. It is not the list of pages:
// an entry's README that isn't named here is still a page, listed under its top folder's group
// (`net/testing` under `net`'s), or under "More" when that folder is new too.
import type { StarlightUserConfig } from "@astrojs/starlight/types";

import type { EntryPage, SitePages } from "./pages.ts";

type SidebarItem = NonNullable<StarlightUserConfig["sidebar"]>[number];

/** The sidebar's groups, each with its entries' top folders under `src/`, in order. */
const GROUPS: readonly {
  readonly label: string;
  readonly entries: string[];
}[] = [
  { label: "Game", entries: ["game"] },
  { label: "Simulation", entries: ["core", "input"] },
  { label: "Presentation", entries: ["render-three", "audio"] },
  { label: "Data", entries: ["content", "save"] },
  { label: "App", entries: ["foldkit"] },
  { label: "Co-op", entries: ["net"] },
];

/** The group of entries no group names. */
const OTHER_GROUP = "More";

const topFolder = (page: EntryPage) => page.entry.split("/", 1)[0] ?? "";

/** The entries by group: each group's own order, then by path, so `net/worker` follows `net`. */
export const groupedEntries = (
  entries: readonly EntryPage[]
): { readonly label: string; readonly pages: EntryPage[] }[] => {
  const known = new Set(GROUPS.flatMap((group) => group.entries));
  const groups = [
    ...GROUPS.map((group) => ({
      label: group.label,
      pages: group.entries.flatMap((folder) =>
        entries.filter((page) => topFolder(page) === folder)
      ),
    })),
    {
      label: OTHER_GROUP,
      pages: entries.filter((page) => !known.has(topFolder(page))),
    },
  ];
  return groups.filter((group) => group.pages.length > 0);
};

/**
 * Starlight's sidebar: the landing page, the entries by group, then the glossary. A page is
 * named by its slug, and Starlight labels it with its title, an entry's import path.
 */
export const sidebar = (pages: SitePages): SidebarItem[] => [
  {
    label: "arcadekit",
    items: [{ label: "Overview", link: pages.home.link }],
  },
  ...groupedEntries(pages.entries).map((group) => ({
    label: group.label,
    items: group.pages.map((page) => page.slug),
  })),
  { label: "Reference", items: [pages.glossary.slug] },
];
