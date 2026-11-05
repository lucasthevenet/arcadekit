import { decodeSpriteSheet, makeSpriteSheet } from "@arcadekit/render-three";
import type { SpriteSheet } from "@arcadekit/render-three";
import { Effect } from "effect";

import { PUSH_PUZZLE_SPRITE_TAGS } from "./board";

// A stand-in for the app's push-puzzle sheet, for tests: every tag the view draws, as 16 px
// frames in one row, and an image that is only a size. Nothing here needs WebGL.

const FRAME_COUNTS: Partial<Record<string, number>> = {
  floor: 3,
  "player/idle": 2,
  "player/walk": 4,
  "player/up": 4,
  "player/down": 4,
};

/** A sheet with `tags` (all of the view's by default), each frame 16x16 and 100 ms. */
export const testSheet = (
  tags: readonly string[] = PUSH_PUZZLE_SPRITE_TAGS
): SpriteSheet => {
  const frames: object[] = [];
  const frameTags: object[] = [];
  for (const name of tags) {
    const count = FRAME_COUNTS[name] ?? 1;
    const from = frames.length;
    for (let i = 0; i < count; i++) {
      frames.push({
        filename: `${name} ${i}`,
        frame: { x: frames.length * 16, y: 0, w: 16, h: 16 },
        duration: 100,
      });
    }
    frameTags.push({ name, from, to: frames.length - 1 });
  }
  const width = Math.max(16, frames.length * 16);
  const data = Effect.runSync(
    decodeSpriteSheet("test.json", {
      frames,
      meta: { image: "test.png", size: { w: width, h: 16 }, frameTags },
    })
  );
  return makeSpriteSheet(data, { width, height: 16 } as TexImageSource);
};
