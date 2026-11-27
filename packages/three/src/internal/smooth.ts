import * as Color from "arcadekit/Color";
import type { EntityColumn } from "arcadekit/ecs";
import * as Transform2d from "arcadekit/Transform2d";
import * as Transform3d from "arcadekit/Transform3d";

import type { KindOptions } from "../Three.ts";
import type { Angle, Numbers, Xy, Xyz, Xyzw } from "./columns.ts";

/**
 * What the app keeps of its entities a tick ago, as `Transform3d.smooth`,
 * `Transform2d.smooth` and `Color.smooth` hand it out for the frame: those
 * a kind reads.
 *
 * @internal
 */
export interface Stores {
  readonly solid: Transform3d.Smooth | undefined;
  readonly flat: Transform2d.Smooth | undefined;
  readonly color: Color.Smooth | undefined;
}

/**
 * Asks the app for the stores a kind drawn smoothly reads in this frame: its
 * transform's, flat or not, and with a colour, the colour's. Each is an
 * Effect a frame runs and allocates for, so a kind asks for no other.
 *
 * @internal
 */
export function* storesOf(flat: boolean, colored: boolean) {
  return {
    solid: flat ? undefined : yield* Transform3d.smooth,
    flat: flat ? yield* Transform2d.smooth : undefined,
    color: colored ? yield* Color.smooth : undefined,
  } satisfies Stores;
}

/**
 * What a system draws its entities between their last two places with: the
 * app's store, which a frame system of the game's own reads too, so that both
 * draw an entity in the same place.
 *
 * @internal
 */
export class Smooth {
  private solidStore: Transform3d.Smooth | undefined;
  private flatStore: Transform2d.Smooth | undefined;
  private colorStore: Color.Smooth | undefined;
  private readonly snap: number | undefined;

  constructor(snap: number | undefined) {
    this.snap = snap;
  }

  /** Starts a frame, with the app's stores as the frame hands them. */
  begin(stores: Stores): void {
    this.solidStore = stores.solid;
    this.flatStore = stores.flat;
    this.colorStore = stores.color;
  }

  position(start: number, end: number, from: Xyz, entities: EntityColumn): Xyz {
    return this.solidStore!.positions(start, end, from, entities, this.snap);
  }

  rotation(
    start: number,
    end: number,
    from: Xyzw,
    entities: EntityColumn
  ): Xyzw {
    return this.solidStore!.rotations(start, end, from, entities);
  }

  scale(start: number, end: number, from: Xyz, entities: EntityColumn): Xyz {
    return this.solidStore!.scales(start, end, from, entities);
  }

  flatPosition(
    start: number,
    end: number,
    from: Xy,
    entities: EntityColumn
  ): Xy {
    return this.flatStore!.positions(start, end, from, entities, this.snap);
  }

  flatRotation(
    start: number,
    end: number,
    from: Angle,
    entities: EntityColumn
  ): Angle {
    return this.flatStore!.rotations(start, end, from, entities);
  }

  flatScale(start: number, end: number, from: Xy, entities: EntityColumn): Xy {
    return this.flatStore!.scales(start, end, from, entities);
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
    const out = this.colorStore!.colors(start, end, { r, g, b }, entities);
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
