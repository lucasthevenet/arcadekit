import { hashCell } from "arcadekit/core";
import type { InstancedSprites, SpriteTag } from "arcadekit/render-three";

// The arena floor as one-unit tiles from the sheet: calm grass inside, the stone wall around it
// and the dark void beyond, with a few dirt patches over the grass. Which frame a cell shows is
// here; the scene's tile layer draws the cells on screen, so a big arena costs no more than a
// small one. The patches are no cells: three units by two, at hashed places, in a batch of their
// own that is filled once for an arena.

/** The ground's tags, by the sides of the arena the wall's tiles sit on. */
export interface GroundTags {
  readonly grass: SpriteTag;
  readonly patch: SpriteTag;
  readonly void: SpriteTag;
  readonly n: SpriteTag;
  readonly e: SpriteTag;
  readonly s: SpriteTag;
  readonly w: SpriteTag;
  readonly nw: SpriteTag;
  readonly ne: SpriteTag;
  readonly se: SpriteTag;
  readonly sw: SpriteTag;
}

/** One dirt patch per this many square world units of arena. */
const PATCH_AREA = 420;

/** The hash of two whole numbers as a number in [0, 1), for picking tile variants and patch places. */
export const fraction = (a: number, b: number): number =>
  hashCell(a, b) / 4_294_967_296;

/** Which tag the tile at (col, row) shows, in an arena from -half to half on both axes. */
export const tileTag = (
  tags: GroundTags,
  half: number,
  col: number,
  row: number
): SpriteTag => {
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

/** A tag's frame for a place: its variants picked evenly by the place's hash. */
export const variant = (tag: SpriteTag, pick: number): number =>
  tag.from +
  (Math.floor(pick * (tag.to - tag.from + 1)) % (tag.to - tag.from + 1));

/**
 * Fills `batch` with the dirt patches of an arena `half` units from its centre to its wall: a
 * few soft patches at hashed places, never touching the wall. Every one of them, a few dozen at
 * most, so the batch needs no window: call it when the arena changes, and it keeps showing.
 */
export const fillPatches = (
  batch: InstancedSprites,
  patch: SpriteTag,
  half: number
): void => {
  const patches = Math.floor((4 * half * half) / PATCH_AREA);
  const reach = half - 3;
  batch.begin();
  for (let k = 0; k < patches; k++) {
    const px = Math.round((fraction(k, 7919) * 2 - 1) * reach);
    const pz = Math.round((fraction(k, 104_729) * 2 - 1) * reach);
    batch.push(px, pz, variant(patch, fraction(k, 3)));
  }
  batch.end();
};
