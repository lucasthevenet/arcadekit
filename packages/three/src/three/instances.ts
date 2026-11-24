import * as Assets from "arcadekit/Assets";
import type { ComponentDef } from "arcadekit/ecs";
import * as Query from "arcadekit/Query";
import { Frame, Time } from "arcadekit/Services";
import * as System from "arcadekit/System";

import { FromAssets } from "./assets";
import type { Entries } from "./assets";
import { Instances } from "./mesh";
import type { InstancesOptions, InstancesShared, Look, Loop } from "./mesh";
import { Holdings, Scene } from "./scene";
import type { Kept } from "./scene";
import { required } from "./which";
import type { Needs } from "./which";

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

/** The instances of a look built from assets, while those assets are loaded. */
interface Sourced extends Kept {
  readonly instances: Instances;
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
export function instances<B extends Entries, L extends Look = Look>(
  name: string,
  options: InstancesFromOptions<B, L>
): System.System<never, Needs | Assets.Store, string, "frame">;
export function instances(
  name: string,
  options: InstancesOptions
): System.System<never, Needs, string, "frame">;
// One body for both: the system of a look that is there asks for no store of
// assets, which the second signature says.
export function instances(
  name: string,
  options: InstancesOptions | InstancesFromOptions<Entries>
): System.System<never, Needs | Assets.Store, string, "frame"> {
  const from = "from" in options ? options : undefined;
  const smooth = options.smooth === true;
  const marked = required(options);
  const excluded = options.without ?? [];
  const { color } = options;
  // The terms of a query are a tuple in its type, and a kind with a colour
  // has one more than one without, after the ones its loop reads: its type
  // only says that they are components, and its loop takes any columns.
  const kind = (
    own: readonly ComponentDef[],
    absent: readonly ComponentDef[]
  ): Query.Query<Query.Reading<readonly ComponentDef[]>, never> =>
    Query.all(...own, ...(color === undefined ? [] : [color])).pipe(
      Query.with(...marked),
      Query.without(...excluded, ...absent)
    );
  // With a colour, the same kinds once more for the entities without one,
  // which are drawn white: a colour on some changes how those look, and
  // hides nothing.
  const plain = (
    own: readonly ComponentDef[],
    absent: readonly ComponentDef[]
  ): Query.Query<Query.Reading<readonly ComponentDef[]>, never> | undefined =>
    color === undefined
      ? undefined
      : Query.all(...own).pipe(
          Query.with(...marked),
          Query.without(...excluded, ...absent, color)
        );
  // An entity's table has a rotation or it does not, and a scale or not:
  // four queries of the kind's transform, each handed exactly the columns
  // its entities have.
  const { Position, Rotation, Scale } = options.transform;
  const shapes: readonly (readonly [
    Loop,
    readonly ComponentDef[],
    readonly ComponentDef[],
  ])[] = [
    ["placed", [Position], [Rotation, Scale]],
    ["sized", [Position, Scale], [Rotation]],
    ["turned", [Position, Rotation], [Scale]],
    ["whole", [Position, Rotation, Scale], []],
  ];
  const kinds = shapes.map(([loop, own, absent]) => ({
    loop,
    query: kind(own, absent),
    plain: plain(own, absent),
  }));
  return System.frame(name, function* () {
    const kept = yield* Scene;
    // Which tick the game is at and how far towards the next the frame is:
    // asked only by a system that draws between the two.
    const tick = smooth ? (yield* Time).tick : 0;
    const frame = smooth ? yield* Frame : undefined;
    let drawn: Instances | undefined;
    if (from === undefined) {
      drawn = kept._kept.get(name) as Instances | undefined;
      if (drawn === undefined) {
        drawn = new Instances(
          kept.scene,
          name,
          options as InstancesOptions,
          new Holdings(kept._owned)
        );
        kept._kept.set(name, drawn);
      }
    } else {
      let sourced = kept._kept.get(name) as FromAssets<Sourced> | undefined;
      if (sourced === undefined) {
        // The room the instances came to need is kept from one loading of
        // the bundle to the next.
        let room = from.capacity ?? 256;
        const { _owned, scene } = kept;
        sourced = new FromAssets(
          yield* Assets.Store,
          from.from,
          (assets): Sourced => {
            const look = from.look(assets);
            const made = new Instances(
              scene,
              name,
              {
                ...from,
                geometry: look.geometry,
                material: look.material,
                capacity: room,
              },
              new Holdings(_owned)
            );
            return {
              instances: made,
              dispose: () => {
                ({ room } = made);
                made.dispose();
                from.free?.(look);
              },
            };
          }
        );
        kept._kept.set(name, sourced);
      }
      drawn = sourced.now()?.instances;
      // Its assets are not there: nothing of it is in the scene.
      if (drawn === undefined) {
        return;
      }
    }
    // Plain loops from here on: one pass over the columns of each kind.
    drawn.begin(tick, frame?.alpha ?? 0, frame?.count ?? 0);
    const { loops, plain: white } = drawn;
    for (const each of kinds) {
      (yield* each.query).eachChunk(loops[each.loop]);
      if (each.plain !== undefined) {
        (yield* each.plain).eachChunk(white[each.loop]);
      }
    }
    drawn.finish();
  });
}
