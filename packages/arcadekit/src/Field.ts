/**
 * The field types a component is made of.
 *
 *   const Hero = Component.define("game/Hero", {
 *     hp: Field.i32,                                   // a number, in a typed array
 *     name: Field.json<string>(),                      // plain data
 *     born: Field.schema(Schema.Date),                 // any value a schema describes
 *     sprite: Field.transient<Sprite>(),               // not saved
 *   })
 *
 * Numbers go in typed fields. Any other field declares what snapshots and the
 * hash do with it: `json` and `schema` fields are saved and hashed, and
 * `transient` fields are neither.
 */
import { Schema } from "effect";

import { Field } from "./ecs/Component";
import type { FieldDef } from "./ecs/Component";

/**
 * A 32-bit float, in a `Float32Array`: a position, a speed.
 *
 * @category Fields
 */
export const { f32 } = Field;

/**
 * A 64-bit float, in a `Float64Array`, for a number that needs full precision.
 *
 * @category Fields
 */
export const { f64 } = Field;

/**
 * A signed 32-bit integer, in an `Int32Array`.
 *
 * @category Fields
 */
export const { i32 } = Field;

/**
 * An unsigned 32-bit integer, in a `Uint32Array`.
 *
 * @category Fields
 */
export const { u32 } = Field;

/**
 * An unsigned 16-bit integer, in a `Uint16Array`.
 *
 * @category Fields
 */
export const { u16 } = Field;

/**
 * An unsigned 8-bit integer, in a `Uint8Array`: a flag or a small count.
 *
 * @category Fields
 */
export const { u8 } = Field;

/**
 * A reference to another entity, such as a target or a parent. The id is stored
 * in a `Float64Array`, eight bytes per row, and is saved and hashed as a
 * number.
 *
 * **When to use**
 *
 * Use it when the code that reads the id checks it. For a reference that must
 * never dangle, use `Component.relation`, which the world keeps up to date.
 *
 * **Gotchas**
 *
 * The field holds whatever id was written to it. Once its entity is despawned
 * the id is stale, and checking it with `isAlive` is up to the code that reads
 * it.
 *
 * @category Fields
 */
export const { entity } = Field;

/**
 * Plain data, saved and hashed as is: a string, number, boolean, bigint, null
 * or undefined, or an array or object of strings, numbers, booleans and null.
 * `Field.json<string>()`.
 *
 * **Gotchas**
 *
 * - An array or an object is saved and hashed as its `JSON.stringify` text,
 *   once per hash, and is loaded as whatever JSON parses that text into: a Date
 *   inside an object comes back as a string. Give such a value a schema, with
 *   `Field.schema`.
 * - A value that isn't plain data can't be saved: the snapshot is refused and
 *   names the field.
 *
 * @category Fields
 */
export const { json } = Field;

/**
 * A value of any type, saved and hashed through the given codec: an `encode` to
 * plain data and a `decode` back. `Field.schema` is built on it.
 *
 * **Gotchas**
 *
 * - A value its `encode` rejects can't be saved: the snapshot is refused and
 *   names the field. A loaded value its `decode` rejects is refused the same
 *   way.
 * - The value is encoded on every hash of the world, so reserve this field type
 *   for small or rare values.
 *
 * @category Fields
 */
export const { ref } = Field;

/**
 * A value that is neither saved nor hashed, such as a sprite or a handle to
 * something outside the game. It is `undefined` after a load.
 *
 * @category Fields
 */
export const { transient } = Field;

/**
 * A field that holds any value a schema describes. Snapshots and the hash use
 * the schema's JSON form, so a Date, a bigint or a class with its own schema
 * all work. A value that doesn't match the schema can't be saved, and the
 * snapshot names the field.
 *
 * **Gotchas**
 *
 * The value is encoded on every hash of the world, so reserve this field type
 * for small or rare values.
 *
 * @category Fields
 */
export const schema = <S extends Schema.Codec<unknown, unknown>>(
  definition: S
): FieldDef<S["Type"], S["Type"][]> => {
  const codec = Schema.toCodecJson(definition);
  const encode = Schema.encodeUnknownSync(codec);
  const decode = Schema.decodeUnknownSync(codec);

  return ref<S["Type"]>({
    encode: (value) => encode(value),
    decode: (data) => decode(data) as S["Type"],
  });
};
