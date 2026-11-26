import * as Assets from "arcadekit/Assets";
import * as Query from "arcadekit/Query";
import { Frame, Time } from "arcadekit/Services";
import * as System from "arcadekit/System";

import type { InstancesOptions, InstancesShared, Look } from "../Instances.ts";
import { Scene } from "../Scene.ts";
import type { Entries, Needs } from "../Three.ts";
import { FromAssets } from "./assets.ts";
import { Holdings, heldIn } from "./holdings.ts";
import type { Kept } from "./holdings.ts";
import { placedBy, required } from "./kind.ts";
import type { Placeable, Placing } from "./kind.ts";
import { Instances } from "./mesh.ts";

/** The options of `Gltf.instances`, as its system reads them. */
interface Bundled<B extends Entries, L extends Look> extends InstancesShared {
  readonly from: Assets.Bundle<B>;
  readonly look: (assets: Assets.Loaded<B>) => L;
  readonly free?: (look: L) => void;
}

/** The instances of a look built from assets, while those assets are loaded. */
interface Sourced extends Kept {
  readonly instances: Instances;
}

/**
 * Reads a kind's queries each frame and draws them into its instances. An
 * entity's table has a rotation or not, and a scale or not, and for a kind
 * with a colour, a colour or not: one query hands out each run with the
 * columns its table has, and the loop is chosen once per run.
 */
const drawer = (options: InstancesShared & Placing) => {
  const smooth = options.smooth === true;
  const marked = required(options);
  const excluded = options.without ?? [];
  const { color } = options;
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
  return function* (drawn: Instances) {
    // Which tick the game is at and how far towards the next the frame is:
    // asked only by a system that draws between the two.
    const tick = smooth ? (yield* Time).tick : 0;
    const frame = smooth ? yield* Frame : undefined;
    drawn.begin(tick, frame?.alpha ?? 0, frame?.count ?? 0);
    if (Painted === undefined) {
      (yield* Plain).eachChunk(drawn.drawPlain);
    } else {
      (yield* Painted).eachChunk(drawn.draw);
    }
    drawn.finish();
  };
};

/**
 * The system of `Three.instances`.
 *
 * @internal
 */
export const instances = (
  name: string,
  of: Placeable<InstancesOptions>
): System.System<never, Needs, string, "frame"> => {
  const options = { ...of, transform: placedBy(of.transform) };
  const draw = drawer(options);
  return System.frame(name, function* () {
    const kept = yield* Scene;
    let drawn = heldIn(kept).kept.get(name) as Instances | undefined;
    if (drawn === undefined) {
      drawn = new Instances(
        kept.scene,
        name,
        options,
        new Holdings(heldIn(kept).owned)
      );
      heldIn(kept).kept.set(name, drawn);
    }
    yield* draw(drawn);
  });
};

/**
 * The system of `Gltf.instances`.
 *
 * @internal
 */
export const bundledInstances = <B extends Entries, L extends Look>(
  name: string,
  of: Placeable<Bundled<B, L>>
): System.System<never, Needs | Assets.Store, string, "frame"> => {
  const options = { ...of, transform: placedBy(of.transform) };
  const draw = drawer(options);
  return System.frame(name, function* () {
    const kept = yield* Scene;
    let sourced = heldIn(kept).kept.get(name) as
      | FromAssets<Sourced>
      | undefined;
    if (sourced === undefined) {
      // The room the instances came to need is kept from one loading of
      // the bundle to the next.
      let room = options.capacity ?? 256;
      const { scene } = kept;
      const { owned } = heldIn(kept);
      sourced = new FromAssets(
        yield* Assets.Store,
        options.from,
        (assets: Assets.Loaded<B>): Sourced => {
          const look = options.look(assets);
          const made = new Instances(
            scene,
            name,
            {
              ...options,
              geometry: look.geometry,
              material: look.material,
              capacity: room,
            },
            new Holdings(owned)
          );
          return {
            instances: made,
            dispose: () => {
              ({ room } = made);
              made.dispose();
              options.free?.(look);
            },
          };
        }
      );
      heldIn(kept).kept.set(name, sourced);
    }
    const drawn = sourced.now()?.instances;
    // Its assets are not there: nothing of it is in the scene.
    if (drawn === undefined) {
      return;
    }
    yield* draw(drawn);
  });
};
