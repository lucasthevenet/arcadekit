/**
 * Schemas for the framework's own types, for use in action payloads.
 */
import { Schema } from "effect";

import type { Entity } from "./ecs/component";

/**
 * An entity id: an unsigned 32-bit integer.
 *
 * This checks the shape only. Whether the entity still exists depends on the
 * world, so that check belongs in the handler.
 */
export const EntityId: Schema.Codec<Entity, number> = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 })
) as unknown as Schema.Codec<Entity, number>;
