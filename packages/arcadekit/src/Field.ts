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

export const { entity, f32, f64, i32, json, ref, transient, u16, u32, u8 } =
  Field;

/**
 * A field that holds any value a schema describes. It is saved in a
 * snapshot and counted in the hash in the schema's JSON form, so a Date, a
 * bigint or a class with a schema of its own all work. A value that does
 * not fit the schema cannot be saved, and the snapshot says which field.
 *
 * The value is encoded once for every hash of the world, so keep a field
 * like this for what is small or rare.
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
