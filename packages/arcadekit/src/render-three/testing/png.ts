// Two checks of the PNG a game ships as its sprite sheet, for the game's own tests: they run
// in Node, on the file's bytes, with no canvas to decode it.

import { inflateSync } from "node:zlib";

import type { SpriteSheetData } from "../sprite-sheet";

/**
 * A PNG's width and height, from its IHDR chunk: what a sheet's JSON says under `meta.size`
 * must match.
 *
 * ```ts
 * const png = readFileSync(new URL(sheet.image, spritesDir));
 * expect(pngSize(png)).toStrictEqual({ width: sheet.width, height: sheet.height });
 * ```
 */
export const pngSize = (
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
  const { width, height } = pngSize(png);
  if (png[24] !== 8 || png[25] !== 6 || png[28] !== 0) {
    throw new Error(
      `framesWithSoftAlpha reads an 8-bit RGBA PNG without interlacing, and this one has bit depth ${png[24]}, colour type ${png[25]} and interlace method ${png[28]}: export the sheet as RGBA, 8 bits a channel`
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at);
    if (IDAT.every((byte, i) => png[at + 4 + i] === byte)) {
      chunks.push(png.subarray(at + 8, at + 8 + length));
      size += length;
    }
    at += 12 + length;
  }
  const data = new Uint8Array(size);
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
 * The frames with a pixel neither clear nor opaque, but for those of the tags in `blended`.
 *
 * A batch draws its sprites opaque unless it is made `transparent`: a pixel below half alpha
 * is cut out and the rest is drawn solid. So art drawn that way should be fully opaque or
 * fully clear, and a frame named here has an edge that will not look as it was painted. The
 * tags a view draws blended, such as a soft shadow, go in `blended`. `png` is the sheet's
 * image file, and the result is each such frame's name, in the sheet's order.
 *
 * ```ts
 * const png = readFileSync(new URL(sheet.image, spritesDir));
 * expect(framesWithSoftAlpha(sheet, png, ["shadow"])).toStrictEqual([]);
 * ```
 *
 * Throws for a PNG that is not 8-bit RGBA without interlacing.
 */
export const framesWithSoftAlpha = (
  sheet: SpriteSheetData,
  png: Uint8Array,
  blended: readonly string[] = []
): readonly string[] => {
  const { width, alpha } = pngAlpha(png);
  const skip = new Set<number>();
  for (const name of blended) {
    const tag = sheet.tags.get(name);
    if (tag !== undefined) {
      for (let f = tag.from; f <= tag.to; f++) {
        skip.add(f);
      }
    }
  }
  return sheet.frames.flatMap((frame, index) => {
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
};
