/**
 * Draws every entity of a kind as one instance of one mesh, for crowds.
 *
 *   import * as Instances from "@arcadekit/three/Instances"
 *
 *   const Rocks = Instances.instances("game/Rocks", {
 *     of: Rock,
 *     transform: Transform3d,
 *     geometry: new IcosahedronGeometry(1),
 *     material: new MeshStandardMaterial({ color: "#8a8f98" }),
 *   })
 *
 * `@arcadekit/three/Three` gives the same exports. The system it makes
 * requires `Three.plugin`.
 */
import type * as Assets from "arcadekit/Assets";
import type * as Color from "arcadekit/Color";
import type * as System from "arcadekit/System";
import type { BufferGeometry, InstancedMesh, Material } from "three";

import * as internal from "./internal/instances";
import type { Entries, Needs, TransformOf, Which } from "./Three";

/**
 * How an instance looks: its mesh's geometry and material.
 *
 * @category Models
 */
export interface Look {
  readonly geometry: BufferGeometry;
  readonly material: Material | Material[];
}

/**
 * The options of `Three.instances`, wherever its look comes from.
 *
 * @category Options
 */
export interface InstancesShared extends Which {
  /**
   * `Color.Rgb`, for each instance to have its entity's colour, which
   * multiplies the material's own. An entity without one is drawn in the
   * material's own colour, as if its colour were white.
   *
   *   Three.instances("game/Rocks", { of: Rock, transform: Transform3d, geometry, material, color: Color.Rgb })
   *
   * Each entity's colour is drawn by the space its `space` names:
   *
   * - `Color.Srgb` is a colour as a hex code writes it. The renderer works in
   *   linear colour, so a lookup table converts each number: a hex code's byte
   *   over 255 exactly, and any other number to the nearest sixteenth of a
   *   byte. A number below 0 is drawn as 0 and one over 1 as 1, as CSS
   *   clamps an sRGB colour. NaN or an infinity isn't a colour, and fails the
   *   frame with an error that names the entity.
   * - `Color.Linear` is the renderer's own numbers, passed through as they are.
   *   A number over 1 is brighter than white, which a renderer with bloom can
   *   show.
   *
   * With `smooth`, a colour is interpolated between two ticks like a position,
   * however far it changes, since `snap` doesn't apply to it. It is
   * interpolated in the game's numbers, then converted by the space it has at
   * the later tick.
   */
  readonly color?: typeof Color.Rgb;
  /**
   * How many instances the mesh has room for at first. Defaults to 256. The
   * room doubles when it runs out, which is the only time the system
   * allocates.
   */
  readonly capacity?: number;
  /**
   * Called with the mesh each time one is created, to make it cast shadows or
   * to put it on a layer, for example. The mesh isn't frustum culled, since its
   * instances can be anywhere. A game that knows where they are can turn
   * culling on here.
   */
  readonly prepare?: (mesh: InstancedMesh) => void;
}

/**
 * Options for instances whose look exists when the system is created.
 *
 * @category Options
 */
export interface InstancesOptions extends InstancesShared, Look {}
/**
 * Options for instances whose look is built from assets that are loaded later
 * and released again, such as a level's.
 *
 * @category Options
 */
export interface InstancesFromOptions<
  B extends Entries,
  L extends Look = Look,
> extends InstancesShared {
  /** The bundle the look is built from. The instances are drawn while it is loaded. */
  readonly from: Assets.Bundle<B>;
  /**
   * Builds the look from the bundle's assets, once each time they are loaded.
   * Anything it returns besides a geometry and a material is kept for `free`.
   */
  readonly look: (assets: Assets.Loaded<B>) => L;
  /**
   * Called with what `look` returned, after the mesh is removed from the scene,
   * when the assets are released or the app is closed. Use it to dispose
   * of anything `look` created besides the geometry and the material, which are
   * disposed of for you. The bundle releases the assets themselves.
   */
  readonly free?: (look: L) => void;
}

/**
 * Makes a frame-stage system that draws every entity of a kind as one instance
 * of one mesh.
 *
 *   const Rocks = Three.instances("game/Rocks", {
 *     of: Rock,
 *     transform: Transform3d,
 *     geometry: new IcosahedronGeometry(1),
 *     material: new MeshStandardMaterial({ color: "#8a8f98" }),
 *   })
 *
 * **When to use**
 *
 * Use for crowds, many entities that look the same. For the few entities that
 * are more than a copy of one mesh, use `Three.objects`.
 *
 * **Details**
 *
 * An entity is drawn while it has what `of` specifies, none of `without`, and
 * the `Position` of the kind's `transform`. It is rotated and scaled by that
 * module's `Rotation` and `Scale` when it has them. A kind of `Transform2d`
 * draws in the x-y plane, at z = 0. A kind reads nothing of the other module.
 *
 * - Each frame, it reads the columns directly with `eachChunk`, and writes one
 *   matrix per entity into the mesh's instance buffer. It creates no object,
 *   matrix or vector per entity. It reallocates the buffer only to double it
 *   when it is full.
 * - A `Rotation` is drawn as the rotation it represents, whatever its length,
 *   so it neither skews nor scales the instance. A `Rotation` whose four fields
 *   are 0, as one added without a value is, means no rotation.
 * - Entities are drawn where the last tick left them, unless `smooth` is set.
 * - The mesh is created on the first frame, named after the system, and added
 *   to the scene. When the app is closed, the mesh is removed and disposed
 *   of. So are the geometry and the material, once no other system draws with
 *   them, so share them between systems freely.
 * - It requires `Three.plugin`, and its name must be unique among the app's
 *   systems.
 *
 * With `smooth: true`, each entity is interpolated between its last two
 * positions, at `Frame.alpha` of the way from where it was a tick ago to where
 * it is now:
 *
 * - The image is then up to one tick behind the game. Just after a tick, at an
 *   `alpha` of 0, an entity is drawn where it was before the tick. A game that
 *   ticks only when needed receives an `alpha` of 1 while it rests, and is
 *   drawn where it is. So is a game stepped by hand and drawn with
 *   `app.frame()`, whose `alpha` is 1.
 * - Positions, scales and colours are interpolated linearly. A rotation takes
 *   the shorter arc.
 * - An entity that wasn't drawn in the previous frame is drawn where it is: a
 *   new entity, one in a slot that belonged to another, one that was hidden,
 *   and every entity on the first frame, after a load, or after a frame the
 *   system didn't run in. So is an entity that moved farther than `snap` in a
 *   tick.
 * - When several ticks ran since the last frame, an entity moves from where it
 *   was last drawn. When none ran, it stays between the same two positions as
 *   in the previous frame. A position changed without a tick becomes the new
 *   end of that move, which keeps its start.
 * - What interpolation keeps, each component's value a tick ago, isn't part of
 *   the world. The game's hash, log and save are the same with it or without.
 *
 * A look built from assets, such as a level's texture, is given as the bundle
 * it comes `from` and a function that builds it:
 *
 *   const Rocks = Three.instances("game/Rocks", {
 *     of: Rock,
 *     transform: Transform3d,
 *     from: Forest,
 *     look: ({ bark }) => ({
 *       geometry: new IcosahedronGeometry(1),
 *       material: new MeshStandardMaterial({ map: bark }),
 *     }),
 *   })
 *
 * - The entities are drawn only while the app has the bundle loaded, which
 *   `Assets.during` or a system of your own manages. At any other time, no
 *   mesh of the kind is in the scene.
 * - `look` is called once each time the bundle loads. When the bundle is
 *   released or the app is closed, the mesh is disposed of, with the
 *   geometry and the material once no other system draws with them. Then
 *   `free` receives what `look` returned. A mesh built from a reloaded bundle
 *   starts with the room the previous one had grown to.
 * - It also requires `Assets.plugin`, as the system's type shows.
 *
 * **Gotchas**
 *
 * - Instances are drawn in no particular order.
 *
 * @category Systems
 */
export function instances<
  B extends Entries,
  const O extends Which["of"],
  L extends Look = Look,
>(
  name: string,
  options: InstancesFromOptions<B, L> & {
    readonly of: O;
    readonly transform: TransformOf<O>;
  }
): System.System<never, Needs | Assets.Store, string, "frame">;
export function instances<const O extends Which["of"]>(
  name: string,
  options: InstancesOptions & {
    readonly of: O;
    readonly transform: TransformOf<O>;
  }
): System.System<never, Needs, string, "frame">;
// One body for both: the system of a look that is there asks for no store of
// assets, which the second signature says.
export function instances(
  name: string,
  options: InstancesOptions | InstancesFromOptions<Entries>
): System.System<never, Needs | Assets.Store, string, "frame"> {
  return internal.instances(name, options);
}
