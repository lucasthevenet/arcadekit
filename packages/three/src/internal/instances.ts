import * as Assets from "arcadekit/Assets";
import * as Query from "arcadekit/Query";
import { Frame, Time } from "arcadekit/Services";
import * as System from "arcadekit/System";

import type { InstancesFromOptions, InstancesOptions } from "../Instances";
import { Scene } from "../Scene";
import { FromAssets } from "./assets";
import type { Entries } from "./assets";
import { Holdings } from "./holdings";
import type { Kept } from "./holdings";
import type { Needs } from "./kind";
import { required } from "./kind";
import { Instances } from "./mesh";

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
  // An entity's table has a rotation or not, and a scale or not, and for a
  // kind with a colour, a colour or not: one query hands out each run with
  // the columns its table has, and the loop is chosen once per run.
  const { Position, Rotation, Scale } = options.transform;
  const Plain = Query.all(
    Position,
    Query.maybe(Rotation),
    Query.maybe(Scale)
  ).pipe(Query.with(...marked), Query.without(...excluded));
  const Painted =
    color === undefined
      ? undefined
      : Query.all(
          Position,
          Query.maybe(Rotation),
          Query.maybe(Scale),
          Query.maybe(color)
        ).pipe(Query.with(...marked), Query.without(...excluded));
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
    if (Painted === undefined) {
      (yield* Plain).eachChunk(drawn.drawPlain);
    } else {
      (yield* Painted).eachChunk(drawn.draw);
    }
    drawn.finish();
  });
};
