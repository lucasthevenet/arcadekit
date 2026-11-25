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
import type * as Assets from "arcadekit/Assets";
import type { Entity } from "arcadekit/ecs";
import type * as System from "arcadekit/System";
import type { Object3D } from "three";

import * as internal from "./internal/objects.ts";
import type { Entries, Needs, TransformOf, Which } from "./Three.ts";

/**
 * The options of `Three.objects`, wherever its objects come from.
 *
 * @category Options
 */
export interface ObjectsShared<O extends Object3D = Object3D> extends Which {
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
 * Options for objects whose `make` needs no assets.
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
 * Options for objects built from assets that are loaded later and released
 * again, such as a level's models.
 *
 * @category Options
 */
export interface ObjectsFromOptions<
  B extends Entries,
  O extends Object3D = Object3D,
> extends ObjectsShared<O> {
  /** The bundle the objects are built from. Objects exist while it is loaded. */
  readonly from: Assets.Bundle<B>;
  /**
   * Creates an entity's object from the bundle's assets. It is called on the
   * first frame that the entity matches and the assets are loaded, and again
   * each time the assets load again.
   */
  readonly make: (entity: Entity, assets: Assets.Loaded<B>) => O;
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
 * Objects built from a level's assets name the bundle they come `from`, and
 * `make` receives its assets:
 *
 *   const Trees = Three.objects("game/Trees", {
 *     of: Tree,
 *     transform: Transform3d,
 *     from: Forest,
 *     make: (entity, { oak }) => oak.scene.clone(),
 *   })
 *
 * - Objects exist only while the app has the bundle loaded. Each is created in
 *   the frame the bundle loads. When the bundle is released, every object is
 *   removed and passed to `free` before the scene is next rendered. When the
 *   bundle loads again, each object is created again.
 * - It also requires `Assets.plugin`.
 *
 * @category Systems
 */
// The one made of assets is first, so that the two things its `make` is
// handed are typed from it.
export function objects<
  B extends Entries,
  const K extends Which["of"],
  O extends Object3D = Object3D,
>(
  name: string,
  options: ObjectsFromOptions<B, O> & {
    readonly of: K;
    readonly transform: TransformOf<K>;
  }
): System.System<never, Needs | Assets.Store, string, "frame">;
export function objects<
  const K extends Which["of"],
  O extends Object3D = Object3D,
>(
  name: string,
  options: ObjectsOptions<O> & {
    readonly of: K;
    readonly transform: TransformOf<K>;
  }
): System.System<never, Needs, string, "frame">;
// One body for both, as for `instances`.
export function objects<O extends Object3D>(
  name: string,
  options: ObjectsOptions<O> | ObjectsFromOptions<Entries, O>
): System.System<never, Needs | Assets.Store, string, "frame"> {
  return internal.objects(name, options);
}
