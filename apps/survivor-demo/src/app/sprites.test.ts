import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import { ContentError, loadContent } from "@gamekit/content";
import type { ContentSource } from "@gamekit/content";
import {
  SpriteSheetError,
  decodeSpriteSheet,
  makeSpriteSheet,
} from "@gamekit/render-three";
import type { SpriteSheetData } from "@gamekit/render-three";
import {
  SurvivorsContent,
  survivorsContentDefinition,
} from "@gamekit/survivors";
import {
  SurvivorsSprites,
  missingSpriteTags,
} from "@gamekit/survivors/browser";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { LoadContent } from "./commands";

// The sprite sheet in public/sprites, checked against the content that names its tags, and the
// loading screen's handling of a sheet that can't load. No WebGL: the sheet's image is a stand-in.

const publicDir = new URL("../../public/", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, publicDir));

const fileSource: ContentSource = (file) =>
  Effect.try({
    try: () => JSON.parse(read(`content/${file}`).toString()) as unknown,
    catch: (cause) => new ContentError({ message: String(cause) }),
  });

const content = await Effect.runPromise(
  loadContent({ ...survivorsContentDefinition, source: fileSource })
);
const sheet = await Effect.runPromise(
  decodeSpriteSheet(
    "survivors.json",
    JSON.parse(read("sprites/survivors.json").toString()) as unknown
  )
);

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

describe("the sprite sheet", () => {
  it("has every tag the view draws for the demo's content", () => {
    expect(missingSpriteTags(sheet, content)).toStrictEqual([]);
  });

  it("names its PNG, and the PNG is the size the JSON says", () => {
    const png = read(`sprites/${sheet.image}`);
    expect({
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
    }).toStrictEqual({ width: sheet.width, height: sheet.height });
  });

  it("has no partly transparent pixels but in the aura and shadow, which are drawn blended", () => {
    const png = read(`sprites/${sheet.image}`);
    expect(
      framesWithSoftAlpha(sheet, png, ["aura/ring", "shadow"])
    ).toStrictEqual([]);
  });

  it("gives every hero, enemy and bolt weapon its own sprite", () => {
    expect({
      heroes: content.heroes.filter((def) => def.sprite === undefined),
      enemies: content.enemies.filter((def) => def.sprite === undefined),
      bolts: content.weapons.filter(
        (def) => def.behavior.kind === "bolt" && def.sprite === undefined
      ),
    }).toStrictEqual({ heroes: [], enemies: [], bolts: [] });
  });
});

/** Runs LoadContent with the real content and `load` as the sprite sheet's. */
const loadWith = (load: SurvivorsSprites["Service"]["load"]) =>
  Effect.runPromise(
    LoadContent().effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(SurvivorsContent, { load: Effect.succeed(content) }),
          Layer.succeed(SurvivorsSprites, { load })
        )
      )
    )
  );

describe("loading", () => {
  it("loads the content and the sprite sheet together", async () => {
    const image = { width: 1, height: 1 } as unknown as TexImageSource;
    const message = await loadWith(
      Effect.succeed({ sheet: makeSpriteSheet(sheet, image) })
    );
    expect(message._tag).toBe("LoadedContent");
  });

  it("shows a sheet that can't load on the loading screen, like content", async () => {
    const message = await loadWith(
      Effect.fail(
        new SpriteSheetError({
          file: "sprites/survivors.json",
          message:
            "The sprite sheet file sprites/survivors.json can't be loaded: HTTP 404",
        })
      )
    );
    expect(message).toStrictEqual({
      _tag: "FailedToLoadContent",
      error:
        "The sprite sheet file sprites/survivors.json can't be loaded: HTTP 404",
    });
  });
});
