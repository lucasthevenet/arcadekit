/**
 * The component that gives each entity a colour of its own, which a renderer
 * reads to draw it. An entity's colour is the game's, as its position is, so
 * the game's systems write it and a renderer only reads it.
 *
 *   commands.spawn(
 *     Rock,
 *     Transform3d.Position.of({ x: 0, y: 4, z: 0 }),
 *     Color.Rgb.of({ r: 0xff / 255, g: 0x61 / 255, b: 0x88 / 255, space: Color.Srgb })
 *   )
 *
 * It is an ordinary component of three 32-bit floats and the space they are
 * written in. The game's systems write it, and a save, the world's hash and a
 * replay hold it. Nothing here draws. `@arcadekit/three` draws an instance in
 * its entity's colour when its kind asks for one:
 * `Three.instances(name, { ..., color: Color.Rgb })`.
 *
 * A colour's numbers are written in one of two spaces, and its `space` says
 * which:
 *
 * - `Srgb` is a colour as a hex code or a colour picker writes it, each
 *   number from 0 to 1.
 * - `Linear` is a renderer's own numbers, in which light adds up. A number
 *   can be over 1, for a colour brighter than white.
 */
import { Component, Field } from "./ecs/component";
import type { FieldDef } from "./ecs/component";

/**
 * The space of a colour written as a hex code or a colour picker writes it,
 * each number from 0 to 1. `#ff6188` is an `r` of `0xff / 255`, a `g` of
 * `0x61 / 255` and a `b` of `0x88 / 255`.
 *
 * **When to use**
 *
 * Use for any colour a game picks, such as a team's. For a colour worked out
 * as light, or one brighter than white, use `Color.Linear`.
 *
 * **Gotchas**
 *
 * `@arcadekit/three` draws a number below 0 as 0 and one over 1 as 1, as CSS
 * clamps an sRGB colour, so a byte that wasn't divided by 255 is drawn as 1.
 * NaN or an infinity is not a colour, and fails the frame that draws it with an
 * error that names the entity.
 *
 * @category Spaces
 */
export const Srgb = 0 as const;

/**
 * The space of a renderer's own numbers, linear sRGB, in which the light of
 * two sources adds up. Its `r`, `g` and `b` are those that Three.js's
 * `new Color("#ff6188")` holds. A renderer takes each number as it is, and one
 * over 1 is brighter than white, which a renderer with bloom shows.
 *
 * **When to use**
 *
 * Use for a colour worked out as light, such as a glow that fades, or one
 * brighter than white. For a colour as a hex code writes it, use `Color.Srgb`.
 *
 * @category Spaces
 */
export const Linear = 1 as const;

/**
 * The space a colour's numbers are written in: `Color.Srgb` or `Color.Linear`.
 *
 * @category Spaces
 */
export type Space = typeof Srgb | typeof Linear;

const space: FieldDef<Space, Uint8Array> = { kind: "u8" };

/**
 * An entity's colour: an `r`, a `g` and a `b`, and the `space` they are
 * written in, `Color.Srgb` or `Color.Linear`. Added without a value, it is
 * white.
 *
 *   Color.Rgb.of({ r: 1, g: 0.5, b: 0, space: Color.Srgb })
 *   Color.Rgb.of({ r: 4, g: 2, b: 0, space: Color.Linear })
 *
 * **When to use**
 *
 * Use for the colour a renderer draws an entity in. A system that fades a
 * colour writes its numbers and keeps its space.
 *
 * @category Components
 */
export const Rgb = Component.define(
  "arcadekit/Color.Rgb",
  { r: Field.f32, g: Field.f32, b: Field.f32, space },
  { initial: { r: 1, g: 1, b: 1, space: Srgb } }
);
