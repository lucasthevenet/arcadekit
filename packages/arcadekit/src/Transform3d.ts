/**
 * Position, rotation and scale in three dimensions. These components serve
 * everything that needs to know where things are: the rules that move them, the
 * renderer that draws them, and the sound that plays from them. For a 2D game,
 * use `Transform2d`.
 *
 *   commands.spawn(
 *     Rock,
 *     Transform3d.Position.of({ x: 0, y: 4, z: 0 }),
 *     Transform3d.Rotation.of(Transform3d.axisAngle(0, 0, 1, Math.PI / 2))
 *   )
 *
 * They are ordinary components: columns of 32-bit floats that the game's
 * systems write, and that are saved, hashed and replayed. Nothing here draws. A
 * renderer reads them: `@arcadekit/three` draws an entity at its `Position`,
 * rotated and scaled by its `Rotation` and `Scale` if it has them.
 *
 * Give an entity only the components it needs: `Position` alone for something
 * that only has a location, plus `Rotation` and `Scale` for things that turn or
 * have a size of their own. A save names each by module and component, as the
 * world does: `"arcadekit/Transform3d.Position"`.
 */
import { Component, Field } from "./ecs/component";
import * as Plugin from "./Plugin";

/**
 * An entity's position, in the game's units. Added without a value, it is at
 * the origin.
 *
 * @category Components
 */
export const Position = Component.define("arcadekit/Transform3d.Position", {
  x: Field.f32,
  y: Field.f32,
  z: Field.f32,
});

/**
 * An entity's rotation, as a quaternion. `axisAngle` creates one.
 *
 * Only the direction of the quaternion matters, not its length. A quaternion of
 * any length represents the same rotation as the unit quaternion in its
 * direction, and everything that reads a `Rotation` normalizes it, so one that
 * drifts from length 1 still draws as the same rotation. All four fields at 0,
 * which is a `Rotation` added without a value, means no rotation.
 *
 * @category Components
 */
export const Rotation = Component.define("arcadekit/Transform3d.Rotation", {
  x: Field.f32,
  y: Field.f32,
  z: Field.f32,
  w: Field.f32,
});

/**
 * An entity's size along each axis, where 1 is its original size.
 *
 * **Gotchas**
 *
 * Added without a value it is all zeros, like any component, which means no
 * size at all: a renderer draws nothing. Give it a value when you add it.
 *
 * @category Components
 */
export const Scale = Component.define("arcadekit/Transform3d.Scale", {
  x: Field.f32,
  y: Field.f32,
  z: Field.f32,
});

/**
 * Returns the `Rotation` that turns by `angle` radians about an axis:
 * `Transform3d.axisAngle(0, 1, 0, Math.PI)`. The axis is a direction of any
 * non-zero length; a zero axis gives no rotation. The result has length 1.
 *
 * **Gotchas**
 *
 * It allocates an object, so use it for a spawn or a `world.set`, not in a loop
 * over columns.
 *
 * @category Utilities
 */
export const axisAngle = (x: number, y: number, z: number, angle: number) => {
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
 * Registers the three components, so a save that contains them can be loaded.
 * The plugin that holds a game's rules depends on it, as does any plugin that
 * draws from them, such as `Three.plugin` from `@arcadekit/three`.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/Transform3d", {
  components: [Position, Rotation, Scale],
});
