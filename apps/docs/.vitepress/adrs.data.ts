// The decisions listed on the "Decisions" page (apps/docs/adr.md): each record's number, title,
// status and address, read from docs/adr/ when the site is built.
import { defineLoader } from "vitepress";

import { discoverPages } from "./pages.ts";

export interface AdrSummary {
  readonly number: string;
  readonly title: string;
  readonly status: string;
  readonly link: string;
}

declare const data: readonly AdrSummary[];
export { data };

export default defineLoader({
  watch: ["../../../docs/adr/*.md"],
  load: (): AdrSummary[] =>
    discoverPages().adrs.map(({ number, title, status, link }) => ({
      number,
      title,
      status,
      link,
    })),
});
