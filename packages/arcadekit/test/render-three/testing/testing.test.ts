import { deflateSync } from "node:zlib";

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  InstancedSprites,
  SpriteSheet,
  TileLayer,
} from "../../../src/render-three/index";
import {
  DrawnSprites,
  Png,
  TestSpriteSheet,
} from "../../../src/render-three/testing/index";

// The entry a view's tests import, used as they use it. The PNGs are made here, so each test
// says which pixels its image has.

const be32 = (value: number) => [
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];

/** A PNG chunk. Its CRC is left at 0: these readers don't check it. */
const chunk = (name: string, data: Uint8Array): number[] => [
  ...be32(data.length),
  ...Array.from(name, (letter) => letter.codePointAt(0) ?? 0),
  ...data,
  ...be32(0),
];

/** PNG's Paeth predictor, as the format's specification writes it. */
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

interface PngOptions {
  /** Bit depth, colour type and interlace method. An 8-bit RGBA image without interlacing by default. */
  readonly format?: readonly [number, number, number];
  /** Bytes of pixel data in each IDAT chunk. One chunk by default. */
  readonly chunkBytes?: number;
}

/**
 * A PNG of `width` x `height` pixels from their RGBA bytes, row `y` written with PNG's filter
 * `y % 5`: none, sub, up, average and Paeth in turn, so a reader has to undo each.
 */
const png = (
  width: number,
  height: number,
  rgba: Uint8Array,
  options: PngOptions = {}
): Uint8Array => {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[y * stride + i - 4]! : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + i]! : 0;
      const c = i >= 4 && y > 0 ? rgba[(y - 1) * stride + i - 4]! : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]!;
      raw[y * (stride + 1) + 1 + i] = (rgba[y * stride + i]! - predictor) & 255;
    }
  }
  const packed = deflateSync(raw);
  const chunkBytes = options.chunkBytes ?? packed.length;
  const data: number[] = [];
  for (let at = 0; at < packed.length; at += chunkBytes) {
    data.push(...chunk("IDAT", packed.subarray(at, at + chunkBytes)));
  }
  const [depth, colourType, interlace] = options.format ?? [8, 6, 0];
  return Uint8Array.from([
    // The eight bytes every PNG starts with.
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk(
      "IHDR",
      Uint8Array.from([
        ...be32(width),
        ...be32(height),
        depth,
        colourType,
        0,
        0,
        interlace,
      ])
    ),
    // A chunk that holds no pixels, as a real file has before its image data.
    ...chunk("tEXt", Uint8Array.from([65, 0, 66])),
    ...data,
    ...chunk("IEND", new Uint8Array(0)),
  ]);
};

/** An opaque image with one colour per pixel, so each row's filter has something to predict from. */
const opaque = (width: number, height: number): Uint8Array => {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba.set([(i * 37) & 255, (i * 101) & 255, (i * 13) & 255, 255], i * 4);
  }
  return rgba;
};

/** Sets the alpha of the pixel at (x, y). */
const setAlpha = (
  rgba: Uint8Array,
  width: number,
  x: number,
  y: number,
  alpha: number
) => {
  rgba[(y * width + x) * 4 + 3] = alpha;
};

/** A 48 x 16 image for a sheet of three frames: opaque, with clear pixels in the first frame. */
const image = (): Uint8Array => {
  const rgba = opaque(48, 16);
  for (let y = 0; y < 16; y++) {
    setAlpha(rgba, 48, y, y, 0);
  }
  return rgba;
};

describe(TestSpriteSheet.fromTags, () => {
  it("makes a sheet with each tag's frames in a row, 16 px and 100 ms each", () => {
    const sheet = TestSpriteSheet.fromTags({
      floor: 3,
      wall: 1,
      "player/walk": 4,
    });
    const { data } = sheet;
    expect({
      size: [data.width, data.height],
      tags: [...data.tags.values()].map((tag) => [
        tag.name,
        tag.from,
        tag.to,
        tag.direction,
      ]),
      names: data.frames.map((frame) => frame.name),
      sixth: data.frames[5],
      walkSeconds: data.tags.get("player/walk")?.duration,
    }).toStrictEqual({
      size: [128, 16],
      tags: [
        ["floor", 0, 2, "forward"],
        ["wall", 3, 3, "forward"],
        ["player/walk", 4, 7, "forward"],
      ],
      names: [
        "floor 0",
        "floor 1",
        "floor 2",
        "wall 0",
        "player/walk 0",
        "player/walk 1",
        "player/walk 2",
        "player/walk 3",
      ],
      sixth: {
        name: "player/walk 1",
        x: 80,
        y: 0,
        width: 16,
        height: 16,
        offsetX: 0,
        offsetY: 0,
        sourceWidth: 16,
        sourceHeight: 16,
        duration: 0.1,
      },
      walkSeconds: expect.closeTo(0.4),
    });
    // A sheet a view draws from: a texture named after the image, and a tag that plays.
    expect(sheet.texture.name).toBe("test.png");
    expect(SpriteSheet.frameAt(data, data.tags.get("player/walk")!, 0.25)).toBe(
      6
    );
  });

  it("throws for a sheet with no frame, which no tool exports", () => {
    expect(() => TestSpriteSheet.fromTags({})).toThrow("it has no frames");
    expect(() => TestSpriteSheet.fromTags({ floor: 0 })).toThrow(
      "it has no frames"
    );
  });
});

describe(DrawnSprites.read, () => {
  const sheet = TestSpriteSheet.fromTags({
    floor: 3,
    wall: 1,
    "player/walk": 4,
  });

  it("gives what was pushed and set, in the order pushed", () => {
    const batch = InstancedSprites.make(sheet, { layer: 1, snap: "screen" });
    InstancedSprites.begin(batch);
    InstancedSprites.push(batch, 0.5, -1.25, 3);
    const player = InstancedSprites.push(batch, 2.53, 4, 6, true);
    InstancedSprites.setTint(
      batch,
      player,
      new THREE.Color(1, 0.5, 0.25),
      0.75
    );
    InstancedSprites.setFlash(batch, player, 0.5);
    InstancedSprites.setLift(batch, player, 0.125);
    InstancedSprites.setLayer(batch, player, 2);
    InstancedSprites.end(batch);
    expect(DrawnSprites.read(batch)).toStrictEqual([
      {
        x: 0.5,
        z: -1.25,
        frame: 3,
        tag: "wall",
        flipX: false,
        tint: [1, 1, 1, 1],
        flash: 0,
        lift: 0,
        layer: 1,
      },
      {
        // As pushed, and as a 32-bit float holds it: no rounding to a pixel.
        x: Math.fround(2.53),
        z: 4,
        frame: 6,
        tag: "player/walk",
        flipX: true,
        tint: [1, 0.5, 0.25, 0.75],
        flash: 0.5,
        lift: 0.125,
        layer: 3,
      },
    ]);
  });

  it("gives only what the last end showed", () => {
    const batch = InstancedSprites.make(sheet);
    expect(DrawnSprites.read(batch)).toStrictEqual([]);
    InstancedSprites.begin(batch);
    InstancedSprites.push(batch, 1, 1, 0);
    InstancedSprites.push(batch, 2, 2, 1);
    InstancedSprites.end(batch);
    InstancedSprites.begin(batch);
    InstancedSprites.push(batch, 3, 3, 2);
    InstancedSprites.end(batch);
    expect(DrawnSprites.read(batch).map((sprite) => sprite.x)).toStrictEqual([
      3,
    ]);
  });

  it('names the first tag that holds a frame, or "" for a frame in none', () => {
    const data = {
      ...sheet.data,
      tags: new Map([...sheet.data.tags].filter(([name]) => name !== "wall")),
    };
    // A sheet of the same frames, with no tag over the wall's: its image is only a size.
    const stand = { width: 128, height: 16 } as unknown as TexImageSource;
    const batch = InstancedSprites.make(SpriteSheet.make(data, stand));
    InstancedSprites.begin(batch);
    InstancedSprites.push(batch, 0, 0, 2);
    InstancedSprites.push(batch, 0, 0, 3);
    InstancedSprites.push(batch, 0, 0, 4);
    InstancedSprites.end(batch);
    expect(DrawnSprites.read(batch).map((sprite) => sprite.tag)).toStrictEqual([
      "floor",
      "",
      "player/walk",
    ]);
  });

  it("gives a tile layer's last fill: each tile at its cell's centre, in the layer's layer and tint", () => {
    const layer = TileLayer.make(sheet, { layer: 2 });
    expect(DrawnSprites.read(layer)).toStrictEqual([]);
    layer.tint.setRGB(0.5, 0.25, 1);
    // Cells (0, 0) and (1, 0): a wall, then nothing.
    TileLayer.draw(layer, { minX: 0, maxX: 2, minZ: 0, maxZ: 1 }, (col) =>
      col === 0 ? 3 : -1
    );
    expect(DrawnSprites.read(layer)).toStrictEqual([
      {
        x: 0.5,
        z: 0.5,
        frame: 3,
        tag: "wall",
        flipX: false,
        tint: [0.5, 0.25, 1, 1],
        flash: 0,
        lift: 0,
        layer: 2,
      },
    ]);
  });
});

describe(Png.size, () => {
  it("reads a PNG's width and height", () => {
    expect(Png.size(png(48, 16, opaque(48, 16)))).toStrictEqual({
      width: 48,
      height: 16,
    });
    // A view of a larger buffer, as a file read into a pool is.
    const padded = Uint8Array.from([1, 2, 3, ...png(300, 7, opaque(300, 7))]);
    expect(Png.size(padded.subarray(3))).toStrictEqual({
      width: 300,
      height: 7,
    });
  });
});

describe(Png.framesWithSoftAlpha, () => {
  // Three 16 px frames in a row: "solid 0", "soft 0" and "shadow 0".
  const sheet = TestSpriteSheet.fromTags({ solid: 1, soft: 1, shadow: 1 }).data;

  it("names no frame of an image whose pixels are all clear or opaque", () => {
    expect(Png.framesWithSoftAlpha(png(48, 16, image()), sheet)).toStrictEqual(
      []
    );
  });

  it("names the frame with a half-clear pixel, under each of PNG's row filters", () => {
    // Rows 0 to 4 are written with the five filters in turn.
    for (let y = 0; y < 5; y++) {
      const rgba = image();
      setAlpha(rgba, 48, 20, y, 128);
      expect(
        Png.framesWithSoftAlpha(png(48, 16, rgba), sheet),
        `a half-clear pixel in row ${y}`
      ).toStrictEqual(["soft 0"]);
    }
  });

  it("names each frame once, in the sheet's order, but for those of the tags drawn blended", () => {
    const rgba = image();
    // The last pixel of the second frame and the first of the third, and more of each.
    setAlpha(rgba, 48, 31, 15, 1);
    setAlpha(rgba, 48, 16, 9, 254);
    setAlpha(rgba, 48, 32, 0, 100);
    setAlpha(rgba, 48, 47, 15, 100);
    const file = png(48, 16, rgba);
    expect({
      all: Png.framesWithSoftAlpha(file, sheet),
      blended: Png.framesWithSoftAlpha(file, sheet, ["shadow"]),
      // A tag the sheet lacks leaves nothing out.
      unknown: Png.framesWithSoftAlpha(file, sheet, ["glow"]),
    }).toStrictEqual({
      all: ["soft 0", "shadow 0"],
      blended: ["soft 0"],
      unknown: ["soft 0", "shadow 0"],
    });
  });

  it("reads pixels split over several chunks", () => {
    const rgba = image();
    setAlpha(rgba, 48, 40, 12, 128);
    expect(
      Png.framesWithSoftAlpha(png(48, 16, rgba, { chunkBytes: 50 }), sheet)
    ).toStrictEqual(["shadow 0"]);
  });

  it.each([
    { what: "16 bits a channel", format: [16, 6, 0] as const },
    { what: "no alpha", format: [8, 2, 0] as const },
    { what: "interlacing", format: [8, 6, 1] as const },
  ])("throws for a PNG with $what", ({ format }) => {
    const [depth, colourType, interlace] = format;
    expect(() =>
      Png.framesWithSoftAlpha(png(48, 16, image(), { format }), sheet)
    ).toThrow(
      `Png.framesWithSoftAlpha reads an 8-bit RGBA PNG without interlacing, and this one has bit depth ${depth}, colour type ${colourType} and interlace method ${interlace}: export the sheet as RGBA, 8 bits a channel`
    );
  });
});
