import * as Color from "arcadekit/Color";
import type { EntityColumn } from "arcadekit/ecs";
import type { Frame, Time } from "arcadekit/Services";
import * as Transform2d from "arcadekit/Transform2d";
import * as Transform3d from "arcadekit/Transform3d";
import { Effect } from "effect";

import type { KindOptions } from "../Three.ts";
import type { Angle, Numbers, Xy, Xyz, Xyzw } from "./columns.ts";

/**
 * What the app keeps of its entities a tick ago, as `Transform3d.smooth`,
 * `Transform2d.smooth` and `Color.smooth` hand it out for the frame.
 *
 * @internal
 */
export interface Stores {
  readonly solid: Transform3d.Smooth;
  readonly flat: Transform2d.Smooth;
  readonly color: Color.Smooth;
}

/**
 * The app's stores, for the frame being drawn.
 *
 * @internal
 */
export const stores: Effect.Effect<Stores, never, Frame | Time> = Effect.all({
  solid: Transform3d.smooth,
  flat: Transform2d.smooth,
  color: Color.smooth,
});

/**
 * What a system draws its entities between their last two places with: the
 * app's store, which a frame system of the game's own reads too, so that both
 * draw an entity in the same place.
 *
 * @internal
 */
export class Smooth {
  private stores: Stores | undefined;
  private readonly snap: number | undefined;

  constructor(snap: number | undefined) {
    this.snap = snap;
  }

  /** Starts a frame, with the app's store as the frame hands it. */
  begin(stores: Stores): void {
    this.stores = stores;
  }

  position(start: number, end: number, from: Xyz, entities: EntityColumn): Xyz {
    return this.stores!.solid.positions(start, end, from, entities, this.snap);
  }

  rotation(
    start: number,
    end: number,
    from: Xyzw,
    entities: EntityColumn
  ): Xyzw {
    return this.stores!.solid.rotations(start, end, from, entities);
  }

  scale(start: number, end: number, from: Xyz, entities: EntityColumn): Xyz {
    return this.stores!.solid.scales(start, end, from, entities);
  }

  flatPosition(
    start: number,
    end: number,
    from: Xy,
    entities: EntityColumn
  ): Xy {
    return this.stores!.flat.positions(start, end, from, entities, this.snap);
  }

  flatRotation(
    start: number,
    end: number,
    from: Angle,
    entities: EntityColumn
  ): Angle {
    return this.stores!.flat.rotations(start, end, from, entities);
  }

  flatScale(start: number, end: number, from: Xy, entities: EntityColumn): Xy {
    return this.stores!.flat.scales(start, end, from, entities);
  }

  /** A colour's three numbers, however far they change. */
  color(
    start: number,
    end: number,
    r: Numbers,
    g: Numbers,
    b: Numbers,
    entities: EntityColumn
  ): Xyz {
    const out = this.stores!.color.colors(start, end, { r, g, b }, entities);
    return { x: out.r, y: out.g, z: out.b };
  }
}

/**
 * What interpolates a kind's entities, when it is drawn smoothly.
 *
 * @internal
 */
export const smoothOf = (which: KindOptions): Smooth | undefined =>
  which.smooth === true ? new Smooth(which.snap) : undefined;
