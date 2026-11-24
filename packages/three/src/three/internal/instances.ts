import * as Assets from "arcadekit/Assets";
import type { ComponentDef } from "arcadekit/ecs";
import * as Query from "arcadekit/Query";
import { Frame, Time } from "arcadekit/Services";
import * as System from "arcadekit/System";

import type { InstancesFromOptions, InstancesOptions } from "../instances";
import { Scene } from "../scene";
import { FromAssets } from "./assets";
import type { Entries } from "./assets";
import { Holdings } from "./holdings";
import type { Kept } from "./holdings";
import type { Needs } from "./kind";
import { required } from "./kind";
import { Instances } from "./mesh";
import type { Loop } from "./mesh";

/** The instances of a look built from assets, while those assets are loaded. */
interface Sourced extends Kept {
  readonly instances: Instances;
}
/**
 * The system of `Three.instances`, for either set of options.
 *
 * @internal
 */
export const instances = (
  name: string,
  options: InstancesOptions | InstancesFromOptions<Entries>
): System.System<never, Needs | Assets.Store, string, "frame"> => {
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
};
