/**
 * Where a thing is: the components the Three.js plugin draws from. This is
 * the package's `@arcadekit/three/Transform` entry, and it imports no
 * Three.js: the plugins that hold a game's rules write these, and a server
 * or a replay that runs them draws nothing and loads no renderer.
 *
 *   import * as Transform from "@arcadekit/three/Transform"
 *
 *   commands.spawn(
 *     Rock,
 *     Transform.Position.of({ x: 0, y: 4, z: 0 }),
 *     Transform.Rotation.of(Transform.axisAngle(0, 0, 1, Math.PI / 2))
 *   )
 *
 * An entity is drawn where its `Position` says. `Rotation` and `Scale` are
 * for the ones that turn or have a size of their own: an entity without
 * them is drawn upright, at the size of its geometry.
 */
import { Component, Field } from "arcadekit/ecs";
import * as Plugin from "arcadekit/Plugin";

/** Where an entity is, in the units of the scene. */
export const Position = Component.define("arcadekit/three/Position", {
  x: Field.f32,
  y: Field.f32,
  z: Field.f32,
});

/**
 * Which way an entity is turned, as a unit quaternion. `axisAngle` makes
 * one. All four fields 0, which is what a field left out is, draws as not
 * turned at all.
 */
export const Rotation = Component.define("arcadekit/three/Rotation", {
  x: Field.f32,
  y: Field.f32,
  z: Field.f32,
  w: Field.f32,
});

/** How large an entity is drawn, along each axis: 1 is the size of its geometry. */
export const Scale = Component.define("arcadekit/three/Scale", {
  x: Field.f32,
  y: Field.f32,
  z: Field.f32,
});

/**
 * The value of a `Rotation` that turns by `angle` radians about an axis,
 * which has to be of length 1: `Transform.axisAngle(0, 1, 0, Math.PI)`. It
 * makes an object, so it is for a spawn or a `world.set`, not for a loop
 * over columns.
 */
export const axisAngle = (
  x: number,
  y: number,
  z: number,
  angle: number
): { x: number; y: number; z: number; w: number } => {
  const sin = Math.sin(angle / 2);
  return { x: x * sin, y: y * sin, z: z * sin, w: Math.cos(angle / 2) };
};

/**
 * Lists the three components, so that a save which names them can be read.
 * The plugin that holds a game's rules depends on it; `Three.plugin`, which
 * draws, does too.
 */
export const plugin = Plugin.make("arcadekit/three/Transform", {
  components: [Position, Rotation, Scale],
});
