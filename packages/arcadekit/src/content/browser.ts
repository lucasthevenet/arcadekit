import { Effect } from "effect";

import { ContentError } from "./loader";
import type { ContentSource } from "./loader";

// Content sources that need a browser (or another runtime with `fetch`). Kept out of the
// root entry so a genre's simulation and content schema can be checked without DOM types.

/** Reads JSON files over HTTP, relative to `baseUrl` (which should end with "/"). */
export const fetchJsonSource =
  (baseUrl: string): ContentSource =>
  (file) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${baseUrl}${file}`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return (await response.json()) as unknown;
      },
      catch: (cause) =>
        new ContentError({
          message: `Could not load ${file}: ${String(cause)}`,
        }),
    });
