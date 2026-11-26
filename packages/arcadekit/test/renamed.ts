/**
 * A snapshot's contents with a component named otherwise, by name alone, for
 * a test of a world that loads a snapshot naming what the program doesn't
 * define. A migration renames a component to its definition, with
 * `Migrate.Contents`, which this is no part of.
 */
import type { SnapshotContents } from "../src/ecs/index.ts";

export const renamedIn = (
  contents: SnapshotContents,
  from: string,
  to: string
): SnapshotContents => {
  for (const component of contents.components) {
    if (component.name === from) {
      component.name = to;
    }
  }
  for (const table of contents.tables) {
    const at = table.components.indexOf(from);
    if (at !== -1) {
      table.components[at] = to;
      table.columns[to] = table.columns[from] ?? {};
      delete table.columns[from];
    }
  }
  for (const set of [...contents.sparse, ...contents.singletons]) {
    if (set.component === from) {
      set.component = to;
    }
  }
  return contents;
};
