/**
 * Where a thing is in a flat game: its position, how far it is turned, and
 * how large it is. The same three components as `Transform3d`, for a game
 * that has two dimensions and no use for a third.
 *
 *   commands.spawn(
 *     Card,
 *     Transform2d.Position.of({ x: 120, y: 80 }),
 *     Transform2d.Rotation.of({ angle: Math.PI / 6 })
 *   )
 *
 * They are ordinary components: columns of 32-bit floats, written by the
 * game's systems, saved, hashed and replayed. Nothing here draws. A
 * renderer reads them: `@arcadekit/three` draws an entity in the plane of
 * x and y, turned about the axis that comes out of it.
 *
 * A game uses one of the two for a thing, not both. They are different
 * components, with different names, and nothing keeps one in step with
 * the other.
 */
import { Component, Field } from "./ecs/component";
import * as Plugin from "./Plugin";

/**
 * Where an entity is, in the units of the game's space.
 *
 * @category Components
 */
export const Position = Component.define("arcadekit/Transform2d.Position", {
  x: Field.f32,
  y: Field.f32,
});

/**
 * How far an entity is turned, in radians: a positive angle turns from the
 * x axis towards the y axis, which is anticlockwise where y points up and
 * clockwise where it points down.
 *
 * @category Components
 */
export const Rotation = Component.define("arcadekit/Transform2d.Rotation", {
  angle: Field.f32,
});

/**
 * How large an entity is, along each axis: 1 is the size it is made at.
 *
 * @category Components
 */
export const Scale = Component.define("arcadekit/Transform2d.Scale", {
  x: Field.f32,
  y: Field.f32,
});

/**
 * Lists the three components, so that a save which names them can be read.
 * The plugin that holds a game's rules depends on it, and so does one that
 * draws from them, as `Three.plugin` of `@arcadekit/three` does.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/Transform2d", {
  components: [Position, Rotation, Scale],
});
