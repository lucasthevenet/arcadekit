/**
 * What colour an entity is: the components a renderer reads to draw each
 * entity in a colour of its own. A colour is the game's to say, as where a
 * thing is, so the rules write it and a renderer only reads it.
 *
 *   commands.spawn(
 *     Rock,
 *     Transform3d.Position.of({ x: 0, y: 4, z: 0 }),
 *     Color.Srgb.of({ r: 0xff / 255, g: 0x61 / 255, b: 0x88 / 255 })
 *   )
 *
 * They are ordinary components: columns of 32-bit floats that the game's
 * systems write, and that are saved, hashed and replayed. Nothing here draws:
 * `@arcadekit/three` draws an instance in its entity's colour when its kind is
 * given one, `Three.instances(name, { ..., color: Color.Srgb })`.
 *
 * There are two, for the two ways of writing a colour's numbers, and which one
 * an entity has says which its numbers are:
 *
 * - `Srgb`, a colour as a hex code or a colour picker writes it, from 0 to 1.
 * - `Linear`, a renderer's own numbers, in which light adds up: any number,
 *   over 1 for brighter than white.
 */
import { Component, Field } from "./ecs/component";

/**
 * An entity's colour as a hex code or a colour picker writes it: its `r`, `g`
 * and `b`, each from 0 to 1. `#ff6188` is an `r` of `0xff / 255`, a `g` of
 * `0x61 / 255` and a `b` of `0x88 / 255`. Added without a value, it is white.
 *
 * **When to use**
 *
 * Use for any colour a game picks, such as a team's. For one worked out as
 * light, or brighter than white, use `Color.Linear`.
 *
 * **Gotchas**
 *
 * A number below 0 or over 1 is no colour, and the frame that draws it fails
 * with an error that names the entity. A byte, such as 255, is divided by 255
 * first.
 *
 * @category Components
 */
export const Srgb = Component.define(
  "arcadekit/Color.Srgb",
  { r: Field.f32, g: Field.f32, b: Field.f32 },
  { initial: { r: 1, g: 1, b: 1 } }
);

/**
 * An entity's colour in a renderer's own numbers, linear sRGB, in which two
 * lights add up: the `r`, `g` and `b` of Three.js's `new Color("#ff6188")`.
 * Every number is one: over 1 is brighter than white, which a renderer with
 * bloom shows. Added without a value, it is white.
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
