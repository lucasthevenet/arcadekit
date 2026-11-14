/**
 * PNG checks: two checks of the PNG a game ships as its sprite sheet, read from the file's bytes
 * in Node, with no canvas to decode it.
 *
 * A game's test reads its sheet's image with `readFileSync` and checks it against the sheet's
 * JSON: its size, and the frames whose edges would not draw as they were painted. The pixels are
 * inflated with `node:zlib`, so only a test or a script can import this module.
 *
 * @since 0.7.0
 */
import { inflateSync } from "node:zlib";

import { dual } from "effect/Function";

import type * as SpriteSheet from "../sprite-sheet";

/**
 * A PNG's width and height, from its IHDR chunk.
 *
 * **When to use**
 *
 * In a game's test, on its sheet's image file: the sheet's JSON must say the same size under
 * `meta.size`, or the sheet's load fails.
 *
 * **Details**
 *
 * It reads only the header, and checks nothing else of the file.
 *
 * **Example** (The size of a sheet's image)
 *
 * ```ts
 * import { Png } from "arcadekit/render-three/testing";
 * import { Schema } from "effect";
 *
 * // A 2 by 1 PNG, as `readFileSync` would give its bytes.
 * const png = Schema.decodeUnknownSync(Schema.Uint8ArrayFromBase64)(
 *   "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR42mP4z8AAQg0AD3oDfmqBMeEAAAAASUVORK5CYII="
 * );
 * Png.size(png); // => { width: 2, height: 1 }
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const size = (
  png: Uint8Array
): { readonly width: number; readonly height: number } => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

/** PNG's Paeth predictor: whichever of left, up and up-left is nearest left + up - up-left. */
const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
};

/** The four bytes of the name of the chunks that hold a PNG's pixels. */
const IDAT = [0x49, 0x44, 0x41, 0x54] as const;

/**
 * The alpha of every pixel of an 8-bit RGBA PNG, row by row, undoing each row's filter. Enough
 * for a sheet a pixel-art tool exports; anything else throws.
 */
const pngAlpha = (
  png: Uint8Array
): { readonly width: number; readonly alpha: Uint8Array } => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const { width, height } = size(png);
  if (png[24] !== 8 || png[25] !== 6 || png[28] !== 0) {
    throw new Error(
      `Png.framesWithSoftAlpha reads an 8-bit RGBA PNG without interlacing, and this one has bit depth ${png[24]}, colour type ${png[25]} and interlace method ${png[28]}: export the sheet as RGBA, 8 bits a channel`
    );
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at);
    if (IDAT.every((byte, i) => png[at + 4 + i] === byte)) {
      chunks.push(png.subarray(at + 8, at + 8 + length));
      bytes += length;
    }
    at += 12 + length;
  }
  const data = new Uint8Array(bytes);
  let filled = 0;
  for (const chunk of chunks) {
    data.set(chunk, filled);
    filled += chunk.length;
  }
  const raw = inflateSync(data);
  const stride = width * 4;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? pixels[y * stride + i - 4]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      const c = i >= 4 && y > 0 ? pixels[(y - 1) * stride + i - 4]! : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]!;
      pixels[y * stride + i] =
        (raw[y * (stride + 1) + 1 + i]! + predictor) & 255;
    }
  }
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = pixels[i * 4 + 3]!;
  }
  return { width, alpha };
};

/**
 * The frames of a sheet with a pixel neither clear nor opaque in its PNG, but for those of the
 * tags in `blended`.
 *
 * **When to use**
 *
 * In a game's test, on the sheet it ships: a batch draws its sprites opaque unless it is made
 * `transparent`, cutting out pixels below half alpha and drawing the rest solid, so art drawn
 * that way should be fully opaque or fully clear. A frame it names has an edge that will not
 * look as it was painted.
 *
 * **Details**
 *
 * `png` is the sheet's image file, and `data` its decoded JSON. The tags a view draws blended,
 * such as a soft shadow, go in `blended`; a tag the sheet lacks leaves nothing out. The result is
 * each such frame's name, in the sheet's order. It reads an 8-bit RGBA PNG without interlacing,
 * which a pixel-art tool exports, and throws an `Error` for any other.
 *
 * **Example** (A sheet whose second frame has a soft pixel)
 *
 * ```ts
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { Png } from "arcadekit/render-three/testing";
 * import { Effect, Schema } from "effect";
 *
 * // A 2 by 1 PNG: an opaque pixel, then one at half alpha.
 * const png = Schema.decodeUnknownSync(Schema.Uint8ArrayFromBase64)(
 *   "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR42mP4z8AAQg0AD3oDfmqBMeEAAAAASUVORK5CYII="
 * );
 * // Two frames of one pixel each: "solid", then "glow".
 * const data = Effect.runSync(
 *   SpriteSheet.decode("tiny.json", {
 *     frames: [
 *       { filename: "solid", frame: { x: 0, y: 0, w: 1, h: 1 } },
 *       { filename: "glow", frame: { x: 1, y: 0, w: 1, h: 1 } },
 *     ],
 *     meta: {
 *       image: "tiny.png",
 *       size: { w: 2, h: 1 },
 *       frameTags: [{ name: "glow", from: 1, to: 1 }],
 *     },
 *   })
 * );
 * Png.framesWithSoftAlpha(png, data); // => ["glow"]
 * // The glow is drawn blended, so its soft pixel is meant.
 * Png.framesWithSoftAlpha(png, data, ["glow"]); // => []
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const framesWithSoftAlpha: {
  (
    data: SpriteSheet.Data,
    blended?: readonly string[]
  ): (png: Uint8Array) => readonly string[];
  (
    png: Uint8Array,
    data: SpriteSheet.Data,
    blended?: readonly string[]
  ): readonly string[];
} = dual(
  (args) => args[0] instanceof Uint8Array,
  (
    png: Uint8Array,
    data: SpriteSheet.Data,
    blended: readonly string[] = []
  ): readonly string[] => {
    const { width, alpha } = pngAlpha(png);
    const skip = new Set<number>();
    for (const name of blended) {
      const tag = data.tags.get(name);
      if (tag !== undefined) {
        for (let f = tag.from; f <= tag.to; f++) {
          skip.add(f);
        }
      }
    }
    return data.frames.flatMap((frame, index) => {
      if (skip.has(index)) {
        return [];
      }
      for (let { y } = frame; y < frame.y + frame.height; y++) {
        for (let { x } = frame; x < frame.x + frame.width; x++) {
          const a = alpha[y * width + x]!;
          if (a !== 0 && a !== 255) {
            return [frame.name];
          }
        }
      }
      return [];
    });
  }
);
