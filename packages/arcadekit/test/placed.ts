import { assert } from "vitest";

import type { Spawned } from "../src/index";
import type { Entity } from "../src/index";
import type { ReadingWorld } from "../src/Services";

/**
 * The entity of an id `Commands.spawn` returned, failing the test if its
 * spawn has not been applied.
 */
export const placedIn = (
  world: Pick<ReadingWorld, "placed">,
  id: Spawned
): Entity => {
  const entity = world.placed(id);
  assert(entity !== undefined, `the spawn of ${id} was not applied`);
  return entity;
};
