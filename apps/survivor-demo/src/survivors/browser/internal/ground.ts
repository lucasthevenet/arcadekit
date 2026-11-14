/**
 * The arena's ground: one-unit tiles from the sheet, calm grass inside, the stone wall around it
 * and the dark void beyond, with a few dirt patches over the grass.
 *
 * Which frame a cell shows is here; the arena's sprites draw the cells on screen with a tile
 * layer, so a big arena costs no more than a small one. The patches are no cells: three units by
 * two, at hashed places, in a batch of their own that is filled once for an arena. A cell's
 * variant and a patch's place come from a hash of whole numbers, so the ground looks the same
 * wherever the camera is and on every visit.
 *
 * Plain on purpose: a frame draws whole before the browser shows it, and these are functions of
 * numbers it calls.
 */
import { ExactMath } from "arcadekit/core";
import { InstancedSprites } from "arcadekit/render-three";
import type { SpriteSheet } from "arcadekit/render-three";

/** The ground's tags, the wall's by the side of the arena its tiles sit on. */
export interface Tags {
  readonly grass: SpriteSheet.Tag;
  readonly patch: SpriteSheet.Tag;
  readonly void: SpriteSheet.Tag;
  readonly n: SpriteSheet.Tag;
  readonly e: SpriteSheet.Tag;
  readonly s: SpriteSheet.Tag;
  readonly w: SpriteSheet.Tag;
  readonly nw: SpriteSheet.Tag;
  readonly ne: SpriteSheet.Tag;
  readonly se: SpriteSheet.Tag;
  readonly sw: SpriteSheet.Tag;
}

/** One dirt patch per this many square world units of arena. */
const PATCH_AREA = 420;

/** The hash of two whole numbers as a number in [0, 1), for picking tile variants and patch places. */
export const fraction = (a: number, b: number): number =>
  ExactMath.hashCell(a, b) / 4_294_967_296;

/** Which tag the tile at (col, row) shows, in an arena from -half to half on both axes. */
export const tileTag = (
  tags: Tags,
  half: number,
  col: number,
  row: number
): SpriteSheet.Tag => {
  if (col < -half - 1 || col > half || row < -half - 1 || row > half) {
    return tags.void;
  }
  const west = col < -half;
  const east = col >= half;
  if (row < -half) {
    if (west) {
      return tags.nw;
    }
    return east ? tags.ne : tags.n;
  }
  if (row >= half) {
    if (west) {
      return tags.sw;
    }
    return east ? tags.se : tags.s;
  }
  if (west) {
    return tags.w;
  }
  return east ? tags.e : tags.grass;
};

/** A tag's frame for a place: its variants picked evenly by `pick`, the place's hash in [0, 1). */
export const variant = (tag: SpriteSheet.Tag, pick: number): number =>
  tag.from +
  (Math.floor(pick * (tag.to - tag.from + 1)) % (tag.to - tag.from + 1));

/**
 * Fills `batch` with the dirt patches of an arena `half` units from its centre to its wall: a
 * few soft patches at hashed places, never touching the wall. Every one of them, a few dozen at
 * most, so the batch needs no window: call it when the arena changes, and it keeps showing.
 */
export const fillPatches = (
  batch: InstancedSprites.InstancedSprites,
  patch: SpriteSheet.Tag,
  half: number
): void => {
  const patches = Math.floor((4 * half * half) / PATCH_AREA);
  const reach = half - 3;
  InstancedSprites.begin(batch);
  for (let k = 0; k < patches; k++) {
    const px = Math.round((fraction(k, 7919) * 2 - 1) * reach);
    const pz = Math.round((fraction(k, 104_729) * 2 - 1) * reach);
    InstancedSprites.push(batch, px, pz, variant(patch, fraction(k, 3)));
  }
  InstancedSprites.end(batch);
};
