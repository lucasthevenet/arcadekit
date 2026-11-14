/**
 * Drawn sprites: every sprite a batch shows, or every tile of a tile layer's last fill, read
 * back as a test compares them.
 *
 * A test draws a frame with its view, then reads what the view's batches and layers show, and
 * knows nothing of how a batch stores it. A position is the one pushed: the rounding to a pixel
 * is the shader's, which a test holds by the batch's `snap`.
 *
 * @since 0.7.0
 */
import * as InstancedSprites from "../instanced-sprites";
import { layerBatch, readSprites } from "../internal/sprite-buffers";
import type * as TileLayer from "../tile-layer";

/**
 * One sprite as a batch shows it: its position as pushed, its frame and the tag that holds it,
 * its flip, tint, flash, lift and layer.
 *
 * **When to use**
 *
 * To compare what a view drew with what a test expects, field by field or whole.
 *
 * **Details**
 *
 * `tag` is the sheet's first tag that holds the frame, or `""`. `tint` is `[r, g, b, alpha]`.
 * `layer` is the layer it draws in: the batch's plus its own. A number is as the batch holds
 * it, a 32-bit float.
 *
 * **Example** (A sprite as a test reads it)
 *
 * ```ts
 * import { InstancedSprites } from "arcadekit/render-three";
 * import { DrawnSprites, TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const batch = InstancedSprites.make(TestSpriteSheet.fromTags({ wall: 1 }));
 * InstancedSprites.begin(batch);
 * InstancedSprites.push(batch, 0.5, -1.25, 0);
 * InstancedSprites.end(batch);
 * const wall: DrawnSprites.DrawnSprite | undefined = DrawnSprites.read(batch)[0];
 * wall; // => { x: 0.5, z: -1.25, frame: 0, tag: "wall", flipX: false, tint: [1, 1, 1, 1], flash: 0, lift: 0, layer: 0 }
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export interface DrawnSprite {
  readonly x: number;
  readonly z: number;
  readonly frame: number;
  /** The sheet's first tag that holds the frame, or "". */
  readonly tag: string;
  readonly flipX: boolean;
  /** `[r, g, b, alpha]`. */
  readonly tint: readonly [number, number, number, number];
  readonly flash: number;
  readonly lift: number;
  /** The layer it draws in: the batch's plus its own. */
  readonly layer: number;
}

/**
 * Every sprite a batch shows, in the order pushed. Given a tile layer, every tile of its last
 * fill, in the order filled, each at its cell's centre.
 *
 * **When to use**
 *
 * In a view's test, after it draws a frame: what its batches and layers show.
 *
 * **Details**
 *
 * What it gives is what the last `end` showed. A number is as the batch holds it, a 32-bit
 * float, so a tint of 0.2 reads back as `Math.fround(0.2)`: compare with `toBeCloseTo`, or with
 * values a float holds exactly. It allocates: it is for a test.
 *
 * **Example** (A tile layer's last fill)
 *
 * ```ts
 * import { TileLayer } from "arcadekit/render-three";
 * import { DrawnSprites, TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const ground = TileLayer.make(TestSpriteSheet.fromTags({ floor: 1, wall: 1 }));
 * TileLayer.draw(ground, { minX: 0, maxX: 2, minZ: 0, maxZ: 1 }, (col) => col);
 * DrawnSprites.read(ground).map((tile) => `${tile.tag} at ${tile.x}`); // => ["floor at 0.5", "wall at 1.5"]
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const read = (
  shown: InstancedSprites.InstancedSprites | TileLayer.TileLayer
): readonly DrawnSprite[] => {
  const batch = InstancedSprites.isInstancedSprites(shown)
    ? shown
    : layerBatch(shown);
  const tags = [...batch.sheet.data.tags.values()];
  return readSprites(batch).map((sprite) => ({
    x: sprite.x,
    z: sprite.z,
    frame: sprite.frame,
    tag:
      tags.find((tag) => tag.from <= sprite.frame && sprite.frame <= tag.to)
        ?.name ?? "",
    flipX: sprite.flipX,
    tint: sprite.tint,
    flash: sprite.flash,
    lift: sprite.lift,
    layer: sprite.layer,
  }));
};
