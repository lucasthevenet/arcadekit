// The sidebar and the "Entries" menu, built from the pages found on disk.
//
// GROUPS says which group a known entry is in and in what order. It is not the list of pages:
// an entry's README that isn't named here is still a page, listed under its top folder's group
// (`net/testing` under `net`'s), or under "More" when that folder is new too.
import type { DefaultTheme } from "vitepress";

import type { EntryPage, SitePages } from "./pages.ts";

/** The sidebar's groups, each with its entries' top folders under `src/`, in order. */
const GROUPS: readonly { readonly text: string; readonly entries: string[] }[] =
  [
    { text: "Game", entries: ["game"] },
    { text: "Simulation", entries: ["core", "input"] },
    { text: "Presentation", entries: ["render-three", "audio"] },
    { text: "Data", entries: ["content", "save"] },
    { text: "App", entries: ["foldkit"] },
    { text: "Co-op", entries: ["net"] },
  ];

/** The group of entries no group names. */
const OTHER_GROUP = "More";

const topFolder = (page: EntryPage) => page.entry.split("/", 1)[0] ?? "";

/** The entries by group: each group's own order, then by path, so `net/worker` follows `net`. */
const groupedEntries = (
  entries: readonly EntryPage[]
): { readonly text: string; readonly pages: EntryPage[] }[] => {
  const known = new Set(GROUPS.flatMap((group) => group.entries));
  const groups = [
    ...GROUPS.map((group) => ({
      text: group.text,
      pages: group.entries.flatMap((folder) =>
        entries.filter((page) => topFolder(page) === folder)
      ),
    })),
    {
      text: OTHER_GROUP,
      pages: entries.filter((page) => !known.has(topFolder(page))),
    },
  ];
  return groups.filter((group) => group.pages.length > 0);
};

const entryItems = (pages: SitePages) =>
  groupedEntries(pages.entries).map((group) => ({
    text: group.text,
    items: group.pages.map((page) => ({ text: page.title, link: page.link })),
  }));

/** The "Entries" menu of the top bar: every entry, by group. */
export const entriesNav = (
  pages: SitePages
): DefaultTheme.NavItemWithLink[] | DefaultTheme.NavItemChildren[] =>
  entryItems(pages);

export const sidebar = (pages: SitePages): DefaultTheme.SidebarItem[] => [
  {
    text: "arcadekit",
    items: [{ text: "Overview", link: pages.home.link }],
  },
  ...entryItems(pages),
  {
    text: "Reference",
    items: [
      { text: "Glossary", link: pages.glossary.link },
      {
        text: "Decisions",
        link: pages.adrIndex.link,
        collapsed: true,
        items: pages.adrs.map((adr) => ({
          text: `${adr.number}: ${adr.title}`,
          link: adr.link,
        })),
      },
    ],
  },
];
