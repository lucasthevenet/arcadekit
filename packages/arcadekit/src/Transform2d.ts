/**
 * Position, rotation and scale for a 2D game. These are the same three
 * components as `Transform3d`, for a game that has no use for a third
 * dimension.
 *
 *   commands.spawn(
 *     Card,
 *     Transform2d.Position.of({ x: 120, y: 80 }),
 *     Transform2d.Rotation.of({ angle: Math.PI / 6 })
 *   )
 *
 * They are ordinary components: columns of 32-bit floats that the game's
 * systems write, and that are saved, hashed and replayed. Nothing here draws. A
 * renderer reads them: `@arcadekit/three` draws the entity in the x-y plane,
 * rotated about the axis perpendicular to it.
 *
 * Use one module or the other for an entity, not both. They are distinct
 * components with distinct names, and nothing keeps them in sync: a system that
 * queries `Transform3d.Position` doesn't find an entity that only has
 * `Transform2d.Position`. A save names each by module and component, as the
 * world does: `"arcadekit/Transform2d.Position"`.
 */
import { Component, Field } from "./ecs/component";
import * as Plugin from "./Plugin";

/**
 * An entity's position, in the game's units. Added without a value, it is at
 * the origin.
 *
 * @category Components
 */
export const Position = Component.define("arcadekit/Transform2d.Position", {
  x: Field.f32,
  y: Field.f32,
});

/**
 * An entity's rotation, in radians. A positive angle turns from the x axis
 * towards the y axis, which is anticlockwise when y points up and clockwise
 * when it points down.
 *
 * @category Components
 */
export const Rotation = Component.define("arcadekit/Transform2d.Rotation", {
  angle: Field.f32,
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
export const Scale = Component.define("arcadekit/Transform2d.Scale", {
  x: Field.f32,
  y: Field.f32,
});

/**
 * Registers the three components, so a save that contains them can be loaded.
 * The plugin that holds a game's rules depends on it, as does any plugin that
 * draws from them, such as `Three.plugin` from `@arcadekit/three`.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/Transform2d", {
  components: [Position, Rotation, Scale],
});
