import { readSprites } from "../instanced-sprites";
import type { InstancedSprites } from "../instanced-sprites";

/** `tag`: the sheet's first tag that holds the frame, or "". `tint`: `[r, g, b, alpha]`. */
export interface DrawnSprite {
  readonly x: number;
  readonly z: number;
  readonly frame: number;
  readonly tag: string;
  readonly flipX: boolean;
  readonly tint: readonly [number, number, number, number];
  readonly flash: number;
  readonly lift: number;
  /** The layer it draws in: the batch's plus its own. */
  readonly layer: number;
}

/**
 * Every sprite a batch shows, in the order pushed, with positions as pushed.
 *
 * What it shows is what its last `end` did: a test draws a frame with its view, then reads
 * the view's batches. A number is as the batch holds it, a 32-bit float, so a tint of 0.2
 * reads back as `Math.fround(0.2)`: compare with `toBeCloseTo`, or with values a float holds
 * exactly. A position is the one pushed: the rounding to a pixel is the shader's.
 *
 * ```ts
 * view.draw(puzzle, 0);
 * expect(drawnSprites(view.actors).at(-1)?.tag).toBe("player/idle");
 * ```
 */
export const drawnSprites = (
  batch: InstancedSprites
): readonly DrawnSprite[] => {
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
