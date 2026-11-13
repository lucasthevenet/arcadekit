import { Effect } from "effect";

import { makeSpriteSheet } from "../sprite-loader";
import type { SpriteSheet } from "../sprite-loader";
import { decodeSpriteSheet } from "../sprite-sheet";

/** Every frame is a square of this many pixels. */
const FRAME_SIZE = 16;

/**
 * A sheet with these tags, each with its number of 16 px frames of 100 ms. No image, no WebGL.
 *
 * The frames sit in one row in the order the tags are written, each named after its tag and
 * its place in it (`"player/walk 2"`), and the image is only a size: a view draws from the
 * sheet into its batches, and a test reads them back with `drawnSprites`.
 *
 * ```ts
 * const sheet = testSheet({ floor: 3, wall: 1, "player/walk": 4 });
 * sheet.data.tags.get("player/walk"); // frames 4 to 7
 * ```
 *
 * Throws if no tag is given, or one has no frame: Aseprite exports no such sheet.
 */
export const testSheet = (
  tags: Readonly<Record<string, number>>
): SpriteSheet => {
  const frames: object[] = [];
  const frameTags: object[] = [];
  for (const [name, count] of Object.entries(tags)) {
    const from = frames.length;
    for (let i = 0; i < count; i++) {
      frames.push({
        filename: `${name} ${i}`,
        frame: {
          x: frames.length * FRAME_SIZE,
          y: 0,
          w: FRAME_SIZE,
          h: FRAME_SIZE,
        },
        duration: 100,
      });
    }
    frameTags.push({ name, from, to: frames.length - 1 });
  }
  const width = Math.max(FRAME_SIZE, frames.length * FRAME_SIZE);
  const data = Effect.runSync(
    decodeSpriteSheet("test.json", {
      frames,
      meta: { image: "test.png", size: { w: width, h: FRAME_SIZE }, frameTags },
    })
  );
  // A texture only holds its image until a renderer uploads it, and no test has one.
  const image = { width, height: FRAME_SIZE } as unknown as TexImageSource;
  return makeSpriteSheet(data, image);
};
