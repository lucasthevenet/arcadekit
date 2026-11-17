/**
 * Schemas for the framework's own types, for use in action payloads.
 */
import { Schema } from "effect";

import type { Entity } from "./ecs/component";

/**
 * An entity id: a whole number from 0 up to, not including, 2^53.
 *
 * This checks the shape only. Whether the entity still exists depends on the
 * world, so that check belongs in the handler.
 *
 * @category Schemas
 */
export const EntityId: Schema.Codec<Entity, number> = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
) as unknown as Schema.Codec<Entity, number>;
