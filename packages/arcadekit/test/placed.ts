import { assert } from "vitest";

import { idOf } from "../src/ecs/component.ts";
import type { Spawned } from "../src/index.ts";
import type { Entity } from "../src/index.ts";
import type { ReadingWorld } from "../src/Services.ts";

/**
 * The entity of an id `Commands.spawn` returned, failing the test if its
 * spawn has not been applied.
 */
export const placedIn = (
  world: Pick<ReadingWorld, "placed">,
  id: Spawned
): Entity => {
  const entity = world.placed(id);
  assert(entity !== undefined, `the spawn of ${idOf(id)} was not applied`);
  return entity;
};
