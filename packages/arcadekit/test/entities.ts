import { isEntity } from "../src/ecs/component";
import type { Entity } from "../src/ecs/component";

/** The entity with this id, checked as an id that arrives from outside is. */
export const entity = (id: number): Entity => {
  if (!isEntity(id)) {
    throw new RangeError(`${id} is not an entity id.`);
  }
  return id;
};
