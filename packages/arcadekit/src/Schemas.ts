/**
 * Schemas for arcadekit's own types, for use in the payloads of actions and
 * events.
 *
 *   const Attack = Action.define("duel/Attack", Schema.Struct({ target: EntityId }))
 *
 * The root entry exports `EntityId` itself, with no namespace:
 * `import { EntityId } from "arcadekit"`.
 */
import { Schema, SchemaTransformation } from "effect";

import { entityOf, idOf, isEntity } from "./ecs/component";
import type { Entity } from "./ecs/component";

/**
 * An entity id, which is an integer from 0 up to, but not including, 2^53.
 *
 * **Gotchas**
 *
 * The schema checks only the number. Whether the entity still exists depends
 * on the world, so the handler checks it, with `world.isAlive`.
 *
 * @category Schemas
 */
export const EntityId: Schema.Codec<Entity, number> = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
).pipe(
  Schema.decodeTo(
    Schema.declare(isEntity),
    SchemaTransformation.transform({ decode: entityOf, encode: idOf })
  )
);
