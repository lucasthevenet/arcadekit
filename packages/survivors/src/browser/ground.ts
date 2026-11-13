import { hashCell } from "arcadekit/core";
import { InstancedSprites } from "arcadekit/render-three";
import type { SpriteSheet, SpriteTag } from "arcadekit/render-three";

// The arena floor as one-unit tiles from the sheet: calm grass inside, a few dirt patches, the
// stone wall around it and the dark void beyond. Only the tiles around the camera are drawn,
// refilled when the camera moves onto another tile, so a big arena costs no more than a small one.

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
/** Patches are 3 by 2 units: this many tiles past the window's edge can still show one. */
const PATCH_REACH = 2;

/** The hash of two whole numbers as a number in [0, 1), for picking tile variants and patch places. */
const fraction = (a: number, b: number): number =>
  hashCell(a, b) / 4_294_967_296;

/** Which tag the tile at (col, row) shows, in an arena from -half to half on both axes. */
const tileTag = (
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
const variant = (tag: SpriteTag, pick: number) =>
  tag.from +
  (Math.floor(pick * (tag.to - tag.from + 1)) % (tag.to - tag.from + 1));

/**
 * The ground under a survivors run: a window of tiles around the camera, in one draw call.
 * Add `batch.mesh` to the scene.
 */
export class GroundTiles {
  /** The tiles. It grows with the window, and keeps showing its last fill. */
  readonly batch: InstancedSprites;
  private readonly tags: GroundTags;
  /** What the drawn tiles were filled for: arena, window centre tile and size. */
  private filled = { half: -1, col: 0, row: 0, cols: 0, rows: 0 };

  constructor(sheet: SpriteSheet, tags: GroundTags) {
    this.batch = new InstancedSprites(sheet);
    this.tags = tags;
  }

  /**
   * Shows the ground of an arena `halfSize` units from its centre to its wall, around (x, z),
   * for a view `width` by `depth` world units.
   */
  draw(halfSize: number, x: number, z: number, width: number, depth: number) {
    const half = Math.ceil(halfSize);
    const col = Math.floor(x);
    const row = Math.floor(z);
    const cols = Math.ceil(width / 2) + 2;
    const rows = Math.ceil(depth / 2) + 2;
    const { filled } = this;
    if (
      filled.half === half &&
      filled.col === col &&
      filled.row === row &&
      filled.cols >= cols &&
      filled.rows >= rows
    ) {
      return;
    }
    const sprites = this.batch;
    sprites.begin();
    for (let r = row - rows; r < row + rows; r++) {
      for (let c = col - cols; c < col + cols; c++) {
        sprites.push(
          c + 0.5,
          r + 0.5,
          variant(tileTag(this.tags, half, c, r), fraction(c, r))
        );
      }
    }
    // A few soft dirt patches, never touching the wall, drawn over the grass.
    const patches = Math.floor((4 * half * half) / PATCH_AREA);
    const reach = half - 3;
    for (let k = 0; k < patches; k++) {
      const px = Math.round((fraction(k, 7919) * 2 - 1) * reach);
      const pz = Math.round((fraction(k, 104_729) * 2 - 1) * reach);
      if (
        Math.abs(px - col) <= cols + PATCH_REACH &&
        Math.abs(pz - row) <= rows + PATCH_REACH
      ) {
        const patch = sprites.push(
          px,
          pz,
          variant(this.tags.patch, fraction(k, 3))
        );
        sprites.setLayer(patch, 1);
      }
    }
    sprites.end();
    this.filled = { half, col, row, cols, rows };
  }

  dispose() {
    this.batch.dispose();
  }
}
