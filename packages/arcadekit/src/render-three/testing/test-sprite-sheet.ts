/**
 * Test sprite sheets: a sheet a view's test draws from, made from the tags it names, with no
 * image and no WebGL.
 *
 * Its frames sit in one row in the order the tags are written, each 16 px and 100 ms, and its
 * image is only a size: a view draws from it into its batches, and the test reads them back
 * with `DrawnSprites.read`. It is a `SpriteSheet.SpriteSheet` like any other, made from data
 * the sheet's own decoder checked.
 *
 * @since 0.7.0
 */
import { Effect } from "effect";

import * as SpriteSheet from "../sprite-sheet";

/** Every frame is a square of this many pixels. */
const FRAME_SIZE = 16;

/**
 * Makes a sheet with these tags, each with its number of 16 px frames of 100 ms.
 *
 * **When to use**
 *
 * In a view's test, as the sheet the app would give it: every tag the view draws, or all but
 * one, to check what it draws in that one's place.
 *
 * **Details**
 *
 * Each frame is named after its tag and its place in it (`"player/walk 2"`), and the image is
 * `test.png`. It throws if no tag is given, or one has no frame: Aseprite exports no such
 * sheet.
 *
 * **Example** (A sheet of a floor, a wall and a walk)
 *
 * ```ts
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const sheet = TestSpriteSheet.fromTags({ floor: 3, wall: 1, "player/walk": 4 });
 * const walk = sheet.data.tags.get("player/walk");
 * [walk?.from, walk?.to]; // => [4, 7]
 * sheet.data.frames[5]?.name; // => "player/walk 1"
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const fromTags = (
  tags: Readonly<Record<string, number>>
): SpriteSheet.SpriteSheet => {
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
  // A test helper may run an Effect to build its fixture: the decode is synchronous.
  const data = Effect.runSync(
    SpriteSheet.decode("test.json", {
      frames,
      meta: { image: "test.png", size: { w: width, h: FRAME_SIZE }, frameTags },
    })
  );
  // A texture only holds its image until a renderer uploads it, and no test has one.
  const image = { width, height: FRAME_SIZE } as unknown as TexImageSource;
  return SpriteSheet.make(data, image);
};
