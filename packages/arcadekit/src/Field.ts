/**
 * The fields a component is made of.
 *
 *   const Hero = Component.define("game/Hero", {
 *     hp: Field.i32,                                   // a number, in a typed array
 *     name: Field.json<string>(),                      // plain data
 *     born: Field.schema(Schema.Date),                 // any value a schema describes
 *     sprite: Field.transient<Sprite>(),               // not saved
 *   })
 *
 * A number goes in a typed field. Anything else says, where it is defined,
 * what a snapshot and the hash do with it: `json` and `schema` fields are
 * saved and hashed, a `transient` field is neither.
 */
import { Schema } from "effect";

import { Field } from "./ecs/component";
import type { FieldDef } from "./ecs/component";

/**
 * A 32-bit float, in a `Float32Array`: a position, a speed.
 *
 * @category Fields
 */
export const f32 = Field.f32;
/**
 * A 64-bit float, in a `Float64Array`: a number that needs every digit.
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
 * An unsigned 8-bit integer, in a `Uint8Array`: a flag, a small count.
 *
 * @category Fields
 */
export const u8 = Field.u8;
/**
 * Another entity: a target, a parent. Its id is saved and hashed as a
 * number, and is no longer alive once that entity is despawned.
 *
 * @category Fields
 */
export const entity = Field.entity;
/**
 * Plain data, saved and hashed as JSON: text, a number, a boolean, null,
 * or an array or object made of them. `Field.json<string>()`.
 *
 * @category Fields
 */
export const json = Field.json;
/**
 * A value of any kind, saved and hashed through the encoding it is given:
 * what `Field.schema` is built on.
 *
 * @category Fields
 */
export const ref = Field.ref;
/**
 * A value that is neither saved nor hashed: a sprite, a handle to
 * something outside the game. It is undefined after a load.
 *
 * @category Fields
 */
export const transient = Field.transient;

/**
 * A field that holds any value a schema describes. It is saved in a
 * snapshot and counted in the hash in the schema's JSON form, so a Date, a
 * bigint or a class with a schema of its own all work. A value that does
 * not fit the schema cannot be saved, and the snapshot says which field.
 *
 * The value is encoded once for every hash of the world, so keep a field
 * like this for what is small or rare.
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
