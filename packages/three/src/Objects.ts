/**
 * Keeps one `Object3D` per entity of a kind, for the few entities that are
 * more than a copy of one mesh.
 *
 *   import * as Objects from "@arcadekit/three/Objects"
 *
 *   const Ships = Objects.objects("game/Ships", {
 *     of: Ship,
 *     transform: Transform3d,
 *     make: () => new Mesh(hull, paint),
 *   })
 *
 * `@arcadekit/three/Three` gives the same exports. The system it makes
 * requires `Three.plugin`.
 */
import type { Entity } from "arcadekit/ecs";
import type * as System from "arcadekit/System";
import type { Object3D } from "three";

import * as internal from "./internal/objects.ts";
import type { KindOptions, Needs, TransformOf } from "./Three.ts";

/**
 * The options of `Three.objects` and `Gltf.objects`.
 *
 * @category Options
 */
export interface ObjectsShared<
  O extends Object3D = Object3D,
> extends KindOptions {
  /**
   * Called with an entity's object after it is removed from the scene, when
   * the entity stops matching, its bundle is released, or the app
   * is closed. Use it to dispose of what `make` created for this object alone,
   * such as its own material, as soon as the object goes. Every object's
   * geometries and materials are disposed of when the bundle they were made
   * from is released or the app is closed, once no other system draws
   * with them.
   */
  readonly free?: (object: O, entity: Entity) => void;
}

/**
 * The options of `Three.objects`, whose `make` needs no assets.
 *
 * @category Options
 */
export interface ObjectsOptions<
  O extends Object3D = Object3D,
> extends ObjectsShared<O> {
  /**
   * Creates an entity's object, on the first frame the entity matches. The
   * object is added to the scene, and given the entity's transform.
   */
  readonly make: (entity: Entity) => O;
}

/**
 * Makes a frame-stage system that keeps one `Object3D` per entity of a kind, at
 * the entity's transform.
 *
 *   const Ships = Three.objects("game/Ships", {
 *     of: Ship,
 *     transform: Transform3d,
 *     make: () => new Mesh(hull, paint),
 *   })
 *
 * **When to use**
 *
 * Use for the few entities that are more than a copy of one mesh, such as a
 * model with parts, a light, or something that carries the camera. For crowds,
 * use `Three.instances`.
 *
 * **Details**
 *
 * - `make` is called on the first frame an entity has what `of` specifies,
 *   none of `without`, and the `Position` of the kind's `transform`. Its object
 *   is added to the scene. On the frame the entity stops matching, or is
 *   despawned, the object is removed and passed to `free`.
 * - Each frame, every object receives its entity's `Position`, and its
 *   `Rotation` and `Scale` when the entity has them, all from the kind's
 *   `transform`. A rotation of any length is applied as a unit quaternion. An
 *   entity that loses its `Rotation` or `Scale` is drawn as if it never had
 *   it. Your game sets anything else about an object, in `make` or in a frame
 *   system of its own.
 * - For a kind of `Transform2d`, the system sets the object's x and y, its
 *   rotation about the z axis, and its scale along x and y. Its z position,
 *   tilt and depth scale stay as `make` set them. Set the z position in `make`
 *   to layer one kind in front of another.
 * - An entity that reuses a despawned entity's slot gets its own object.
 * - When the app is closed, or the bundle is released, every object is
 *   removed and passed to `free`. The geometries and materials the objects
 *   were made with are disposed of, once no other system draws with them.
 * - Nothing is kept in the world. A game loaded from a save, or an app that
 *   starts with entities, has its objects created on the first frame.
 * - With `smooth: true`, an object is interpolated between its entity's last
 *   two transforms, as `Three.instances` draws an instance.
 * - It requires `Three.plugin`, and its name must be unique among the app's
 *   systems.
 *
 * @category Systems
 */
export function objects<
  const K extends KindOptions["of"],
  O extends Object3D = Object3D,
>(
  name: string,
  options: ObjectsOptions<O> & {
    readonly of: K;
    readonly transform: TransformOf<K>;
  }
): System.System<never, Needs, string, "frame"> {
  return internal.objects(name, options);
}
