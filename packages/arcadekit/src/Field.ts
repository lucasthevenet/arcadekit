/**
 * The field types a component is made of.
 *
 *   const Hero = Component.define("game/Hero", {
 *     hp: Field.i32,                                   // a number, in a typed array
 *     name: Field.json<string>(""),                    // plain data
 *     born: Field.schema(Schema.Date, new Date(0)),    // any value a schema describes
 *     sprite: Field.transient<Sprite>(),               // not saved
 *   })
 *
 * Numbers go in typed fields. Any other field type says what snapshots and the
 * hash do with its value. `json`, `ref` and `schema` fields are saved and
 * hashed, and `transient` fields are neither.
 *
 * A component spawned or added bare, with no value, holds 0 in a number field,
 * `false` in a `bool` one and undefined in a `transient` one. A `json`, `ref`
 * or `schema` field has no such zero, so it is made with the value it holds
 * then, its initial value.
 */
import { Schema } from "effect";

import { Field } from "./ecs/component.ts";
import type { FieldDef } from "./ecs/component.ts";
import type { Frozen } from "./ecs/frozen.ts";

/**
 * A 32-bit float, in a `Float32Array`, for a position or a speed.
 *
 * @category Fields
 */
export const f32 = Field.f32;
/**
 * A 64-bit float, in a `Float64Array`, for a number that needs full precision.
 *
 * @category Fields
 */
export const f64 = Field.f64;
/**
 * A signed 32-bit integer, in an `Int32Array`.
 *
 * @category Fields
 */
export const i32 = Field.i32;
/**
 * An unsigned 32-bit integer, in a `Uint32Array`.
 *
 * @category Fields
 */
export const u32 = Field.u32;
/**
 * An unsigned 16-bit integer, in a `Uint16Array`.
 *
 * @category Fields
 */
export const u16 = Field.u16;
/**
 * An unsigned 8-bit integer, in a `Uint8Array`, for a small count. A flag is
 * a `Field.bool`.
 *
 * @category Fields
 */
export const u8 = Field.u8;
/**
 * `true` or `false`, kept as 1 or 0 in a `Uint8Array`, for a flag such as
 * whether a door is open. It is `false` in a component added or spawned bare.
 *
 * **Gotchas**
 *
 * - `eachChunk` hands out its column as it is, a `Uint8Array` of 0 and 1,
 *   which a loop reads and writes as numbers. Any number but 0 written there
 *   reads as `true`.
 * - A snapshot and the hash take it for a `Field.u8`. A save written while
 *   the field was a `Field.u8` loads with no migration, 0 as `false` and any
 *   other number as `true`, and a field changed from `Field.bool` to
 *   `Field.u8` loads as 0 and 1.
 *
 * @category Fields
 */
export const bool = Field.bool;
/**
 * A reference to another entity, such as a target or a parent. The id is stored
 * in a `Float64Array`, eight bytes per row, and is saved and hashed as a
 * number. `eachChunk` hands out the column as a `WritableColumn` of
 * `Entity.Ref`, so that no number is written as an id.
 *
 * **When to use**
 *
 * Use when the code that reads the id can do without its entity. For a
 * reference that must never dangle, use `Component.relation`, which the world
 * keeps up to date.
 *
 *   const target = world.live(hunter.target)
 *   if (target !== undefined) world.get(target, Health)
 *
 * **Gotchas**
 *
 * - The field holds whatever id was written to it, which is stale once its
 *   entity is despawned. It reads as an `Entity.Ref`, which no call of the
 *   world takes: `world.live` returns the entity while it is alive, and
 *   undefined after.
 *
 * @category Fields
 */
export const entity = Field.entity;
/**
 * Plain data, saved and hashed as it is. A value is a string, number, boolean,
 * bigint, null or undefined, or an array or object of strings, numbers,
 * booleans and null. `initial` is what the field holds in a component spawned
 * or added bare.
 *
 *   name: Field.json<string>("")
 *   inventory: Field.json<readonly string[]>([])
 *
 * Give it its type. A field given none holds any plain data.
 *
 * A type that holds anything else, such as a `Date`, a `Map` or a class,
 * doesn't compile. Give it `Field.schema` or `Field.ref`.
 *
 * The value reads as read-only all the way down. Replace an array or an
 * object, with `world.set` or an assignment to the field in `each`. A change
 * made in place is one that no change query sees and no refused action undoes.
 *
 * **Gotchas**
 *
 * - An array or an object is saved and hashed as its `JSON.stringify` text,
 *   once per hash, and is loaded as whatever JSON parses that text into.
 * - A value that isn't plain data, which only a cast gets past the compiler,
 *   can't be saved. The snapshot is refused and names the field.
 *
 * @category Fields
 */
export const json = Field.json;
/**
 * A value of any type, saved and hashed through the given codec, an `encode` to
 * plain data and a `decode` back. `Field.schema` is built on it. `initial` is
 * what the field holds in a component spawned or added bare. The value reads
 * as read-only all the way down, as a `json` field's does. Replace it, and
 * don't change it in place.
 *
 * **Gotchas**
 *
 * - A value its `encode` rejects can't be saved. The snapshot is refused, and
 *   its message names the field and says what `encode` threw. A loaded value
 *   its `decode` rejects is refused the same way.
 * - The value is encoded on every hash of the world, so reserve this field type
 *   for small or rare values.
 *
 * @category Fields
 */
export const ref = Field.ref;
/**
 * A value that is neither saved nor hashed, such as a sprite or a handle to
 * something outside the game. It is `undefined` after a load. It reads as
 * read-only all the way down, as a `json` field's does. Replace it, and don't
 * change it in place, which no change query would see.
 *
 * @category Fields
 */
export const transient = Field.transient;

/**
 * A field that holds any value a schema describes. Snapshots and the hash use
 * the schema's JSON form, so a `Date`, a bigint or a class with its own schema
 * all work. A value that doesn't match the schema can't be saved, and the
 * snapshot is refused, naming the field and saying what the schema found wrong.
 * `initial` is what the field holds in a component spawned or added bare.
 *
 *   born: Field.schema(Schema.Date, new Date(0))
 *
 * **Gotchas**
 *
 * - The value is encoded on every hash of the world, so reserve this field
 *   type for small or rare values.
 *
 * @category Fields
 */
export const schema = <S extends Schema.Codec<unknown, unknown>>(
  definition: S,
  initial: NoInfer<Frozen<S["Type"]>>
): FieldDef<S["Type"], S["Type"][]> => {
  const codec = Schema.toCodecJson(definition);
  const encode = Schema.encodeUnknownSync(codec);
  const decode = Schema.decodeUnknownSync(codec);
  return ref<S["Type"]>(
    {
      encode: (value) => encode(value),
      decode: (data) => decode(data) as S["Type"],
    },
    initial
  );
};
