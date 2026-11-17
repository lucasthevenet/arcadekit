/**
 * Where a thing is in three dimensions: its position, which way it is
 * turned, and how large it is. Three components of the game, for whatever
 * needs to know where things are: the rules that move them, what draws
 * them, what is heard from them. A flat game has `Transform2d`.
 *
 *   commands.spawn(
 *     Rock,
 *     Transform3d.Position.of({ x: 0, y: 4, z: 0 }),
 *     Transform3d.Rotation.of(Transform3d.axisAngle(0, 0, 1, Math.PI / 2))
 *   )
 *
 * They are ordinary components: columns of 32-bit floats, written by the
 * game's systems, saved, hashed and replayed. Nothing here draws. A
 * renderer reads them: `@arcadekit/three` draws an entity where its
 * `Position` says, turned and sized by its `Rotation` and `Scale` if it
 * has them.
 */
import { Component, Field } from "./ecs/component";
import * as Plugin from "./Plugin";

/**
 * Where an entity is, in the units of the game's space. A game that is
 * flat gives every `z` as 0.
 */
export const Position = Component.define("arcadekit/Transform3d.Position", {
  x: Field.f32,
  y: Field.f32,
  z: Field.f32,
});

/**
 * Which way an entity is turned, as a quaternion. `axisAngle` makes one.
 *
 * It is the turn that matters and not the length. A quaternion of any
 * length stands for the turn of the one of length 1 along it, and what
 * reads a `Rotation` takes it so: one that a game's rules let drift from
 * length 1, or never made of it, is drawn as the same turn. All four
 * fields 0, which is what a `Rotation` added with no value is, stands for
 * not turned at all.
 */
export const Rotation = Component.define("arcadekit/Transform3d.Rotation", {
  x: Field.f32,
  y: Field.f32,
  z: Field.f32,
  w: Field.f32,
});

/** How large an entity is, along each axis: 1 is the size it is made at. */
export const Scale = Component.define("arcadekit/Transform3d.Scale", {
  x: Field.f32,
  y: Field.f32,
  z: Field.f32,
});

/**
 * The value of a `Rotation` that turns by `angle` radians about an axis:
 * `Transform3d.axisAngle(0, 1, 0, Math.PI)`. The axis is a direction, of
 * any length but none; about no axis at all, three zeros, it is no turn.
 * What it gives is of length 1. It makes an object, so it is for a spawn
 * or a `world.set`, not for a loop over columns.
 */
export const axisAngle = (
  x: number,
  y: number,
  z: number,
  angle: number
): { x: number; y: number; z: number; w: number } => {
  const length = Math.hypot(x, y, z);
  if (length === 0) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  // Over the axis's length: the angle would be another for an axis that
  // is not of length 1, and not only the quaternion's length.
  const sin = Math.sin(angle / 2) / length;
  return { x: x * sin, y: y * sin, z: z * sin, w: Math.cos(angle / 2) };
};

/**
 * Lists the three components, so that a save which names them can be read.
 * The plugin that holds a game's rules depends on it, and so does one that
 * draws from them, as `Three.plugin` of `@arcadekit/three` does.
 */
export const plugin = Plugin.make("arcadekit/Transform3d", {
  components: [Position, Rotation, Scale],
});
