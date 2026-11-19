/**
 * Schemas for arcadekit's own types, for use in action payloads.
 *
 *   const Attack = Action.define("duel/Attack", Schema.Struct({ target: EntityId }))
 *
 * The root entry exports `EntityId` directly: `import { EntityId } from
 * "arcadekit"`.
 */
import { Schema } from "effect";

import type { Entity } from "./ecs/component";

/**
 * An entity id: an integer from 0 up to, but not including, 2^53.
 *
 * The schema checks the shape only. Whether the entity still exists depends on
 * the world, so check that in the handler.
 *
 * @category Schemas
 */
export const EntityId: Schema.Codec<Entity, number> = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
) as unknown as Schema.Codec<Entity, number>;
