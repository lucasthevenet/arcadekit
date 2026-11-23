/**
 * The components that give each entity a colour of its own, which a renderer
 * reads to draw it. An entity's colour is the game's, as its position is, so
 * the game's systems write it and a renderer only reads it.
 *
 *   commands.spawn(
 *     Rock,
 *     Transform3d.Position.of({ x: 0, y: 4, z: 0 }),
 *     Color.Srgb.of({ r: 0xff / 255, g: 0x61 / 255, b: 0x88 / 255 })
 *   )
 *
 * They are ordinary components of three 32-bit floats. The game's systems
 * write them, and a save, the world's hash and a replay hold them. Nothing
 * here draws. `@arcadekit/three` draws an instance in its entity's colour
 * when its kind names one of them:
 * `Three.instances(name, { ..., color: Color.Srgb })`.
 *
 * There are two, one for each way of writing a colour's numbers. The one an
 * entity has says how to read its numbers:
 *
 * - `Srgb` holds a colour as a hex code or a colour picker writes it, each
 *   number from 0 to 1.
 * - `Linear` holds a renderer's own numbers, in which light adds up. A number
 *   can be over 1, for a colour brighter than white.
 */
import { Component, Field } from "./ecs/component";

/**
 * An entity's colour as a hex code or a colour picker writes it, with an `r`,
 * a `g` and a `b` that each run from 0 to 1. `#ff6188` is an `r` of
 * `0xff / 255`, a `g` of `0x61 / 255` and a `b` of `0x88 / 255`. Added
 * without a value, it is white.
 *
 * **When to use**
 *
 * Use for any colour a game picks, such as a team's. For a colour worked out
 * as light, or one brighter than white, use `Color.Linear`.
 *
 * **Gotchas**
 *
 * A number below 0 or over 1, or NaN, is not a colour, and `@arcadekit/three`
 * fails the frame that draws it with an error that names the entity. Divide a
 * byte, such as 255, by 255 first.
 *
 * @category Components
 */
export const Srgb = Component.define(
  "arcadekit/Color.Srgb",
  { r: Field.f32, g: Field.f32, b: Field.f32 },
  { initial: { r: 1, g: 1, b: 1 } }
);

/**
 * An entity's colour in a renderer's own numbers, linear sRGB, in which the
 * light of two sources adds up. Its `r`, `g` and `b` are those that Three.js's
 * `new Color("#ff6188")` holds. A renderer takes each number as it is, and one
 * over 1 is brighter than white, which a renderer with bloom shows. Added
 * without a value, it is white.
 *
 * **When to use**
 *
 * Use for a colour worked out as light, such as a glow that fades, or one
 * brighter than white. For a colour as a hex code writes it, use `Color.Srgb`.
 *
 * @category Components
 */
export const Linear = Component.define(
  "arcadekit/Color.Linear",
  { r: Field.f32, g: Field.f32, b: Field.f32 },
  { initial: { r: 1, g: 1, b: 1 } }
);
