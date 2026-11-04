import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import { PushPuzzleContent } from "@gamekit/push-puzzle";
import { PUSH_PUZZLE_SPRITE_TAGS } from "@gamekit/push-puzzle/browser";
import { SpriteSheetError, decodeSpriteSheet } from "@gamekit/render-three";
import type { SpriteSheetData } from "@gamekit/render-three";
import { Effect } from "effect";
import { Story } from "foldkit";
import { describe, expect, it } from "vitest";

import { LoadContent } from "./commands";
import { Message } from "./message";
import { SHEET_URL, Sprites } from "./sprites";
import { init, update } from "./update";

// The sheet this game ships, and what a failed sheet load does to startup. Loading and
// parsing sheets in general is @gamekit/render-three's tests.

const spritesDir = new URL("../../public/sprites/", import.meta.url);

/** A PNG's width and height, from its IHDR chunk. */
const pngSize = (bytes: Buffer) => ({
  width: bytes.readUInt32BE(16),
  height: bytes.readUInt32BE(20),
});

/** PNG's Paeth predictor: whichever of left, up and up-left is nearest left + up - up-left. */
const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
};

/**
 * The alpha of every pixel of an 8-bit RGBA PNG, row by row, undoing each row's filter. Enough
 * for the sheets in public/sprites; anything else throws.
 */
const pngAlpha = (bytes: Buffer): { width: number; alpha: Uint8Array } => {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0) {
    throw new Error("Only 8-bit RGBA PNGs without interlacing are read here.");
  }
  const chunks: Buffer[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    if (bytes.toString("ascii", at + 4, at + 8) === "IDAT") {
      chunks.push(bytes.subarray(at + 8, at + 8 + length));
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
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
 * The names of frames with partly transparent pixels, leaving out tags drawn blended. The
 * views draw sprites opaque, cutting out pixels below half alpha and drawing the rest solid,
 * so art drawn that way should be fully opaque or fully clear.
 */
const framesWithSoftAlpha = (
  data: SpriteSheetData,
  png: Buffer,
  blended: readonly string[]
): string[] => {
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
};

describe("the push-puzzle sheet", () => {
  it("has every tag the view draws, and an image the size its JSON says", async () => {
    const data = await Effect.runPromise(
      decodeSpriteSheet(
        "push-puzzle.json",
        JSON.parse(
          readFileSync(new URL("push-puzzle.json", spritesDir), "utf-8")
        ) as unknown
      )
    );
    const image = pngSize(readFileSync(new URL(data.image, spritesDir)));
    expect({
      url: SHEET_URL.endsWith("/sprites/push-puzzle.json"),
      missing: PUSH_PUZZLE_SPRITE_TAGS.filter((tag) => !data.tags.has(tag)),
      image,
    }).toStrictEqual({
      url: true,
      missing: [],
      image: { width: data.width, height: data.height },
    });
  });

  it("has no partly transparent pixels, as every sprite is drawn opaque", async () => {
    const data = await Effect.runPromise(
      decodeSpriteSheet(
        "push-puzzle.json",
        JSON.parse(
          readFileSync(new URL("push-puzzle.json", spritesDir), "utf-8")
        ) as unknown
      )
    );
    const png = readFileSync(new URL(data.image, spritesDir));
    expect(framesWithSoftAlpha(data, png, [])).toStrictEqual([]);
  });
});

describe("a sheet that fails to load", () => {
  it("stops startup with its error, like content that fails to load", async () => {
    const failed = new SpriteSheetError({
      file: "sprites/push-puzzle.json",
      message: "The sprite sheet file sprites/push-puzzle.json can't be loaded",
    });
    const message = await LoadContent().effect.pipe(
      Effect.provideService(Sprites, { sheet: Effect.fail(failed) }),
      Effect.provideService(PushPuzzleContent, {
        load: Effect.die("levels are never read"),
      }),
      Effect.runPromise
    );
    expect(message).toStrictEqual(
      Message.FailedToLoadContent({ error: failed.message })
    );
    Story.story(
      update,
      Story.given(init().model),
      Story.message(message),
      Story.model((model) =>
        expect(model.phase).toStrictEqual({
          _tag: "LoadFailed",
          error: failed.message,
        })
      )
    );
  });
});
