import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { SpriteSheetError, decodeSpriteSheet, frameAt } from "./index";
import type { SpriteSheetData } from "./index";

const frame = (x: number, duration = 100) => ({
  frame: { x, y: 0, w: 16, h: 16 },
  rotated: false,
  trimmed: false,
  spriteSourceSize: { x: 0, y: 0, w: 16, h: 16 },
  sourceSize: { w: 16, h: 16 },
  duration,
});

const META = {
  app: "https://www.aseprite.org/",
  version: "1.3",
  image: "sheet.png",
  format: "RGBA8888",
  size: { w: 64, h: 16 },
  scale: "1",
  frameTags: [
    {
      name: "slime/move",
      from: 0,
      to: 1,
      direction: "forward",
      color: "#000000ff",
    },
    { name: "bat/fly", from: 2, to: 3, direction: "pingpong" },
  ],
};

// The same sheet in Aseprite's two forms.
const ARRAY_FORM = {
  frames: [
    { filename: "slime 0.aseprite", ...frame(0) },
    { filename: "slime 1.aseprite", ...frame(16, 200) },
    { filename: "bat 0.aseprite", ...frame(32) },
    { filename: "bat 1.aseprite", ...frame(48) },
  ],
  meta: META,
};
const HASH_FORM = {
  frames: {
    "slime 0.aseprite": frame(0),
    "slime 1.aseprite": frame(16, 200),
    "bat 0.aseprite": frame(32),
    "bat 1.aseprite": frame(48),
  },
  meta: META,
};

const decode = (json: unknown) =>
  Effect.runSync(decodeSpriteSheet("sprites/sheet.json", json));

const decodeError = (json: unknown): SpriteSheetError =>
  Effect.runSync(Effect.flip(decodeSpriteSheet("sprites/sheet.json", json)));

describe(decodeSpriteSheet, () => {
  it.each([
    { form: "array", json: ARRAY_FORM },
    { form: "hash", json: HASH_FORM },
  ])(
    "reads the $form form: frames in order, names, durations and tags",
    ({ json }) => {
      const sheet = decode(json);
      expect([sheet.image, sheet.width, sheet.height]).toStrictEqual([
        "sheet.png",
        64,
        16,
      ]);
      expect(sheet.frames.map((f) => f.name)).toStrictEqual([
        "slime 0.aseprite",
        "slime 1.aseprite",
        "bat 0.aseprite",
        "bat 1.aseprite",
      ]);
      expect(sheet.frames[1]).toStrictEqual({
        name: "slime 1.aseprite",
        x: 16,
        y: 0,
        width: 16,
        height: 16,
        offsetX: 0,
        offsetY: 0,
        sourceWidth: 16,
        sourceHeight: 16,
        duration: 0.2,
      });
      expect(sheet.frameByName.get("bat 0.aseprite")).toBe(2);
      expect([...sheet.tags.values()]).toStrictEqual([
        {
          name: "slime/move",
          from: 0,
          to: 1,
          direction: "forward",
          duration: expect.closeTo(0.3),
        },
        // One loop is frame 2 then 3: a pingpong doesn't repeat either end.
        {
          name: "bat/fly",
          from: 2,
          to: 3,
          direction: "pingpong",
          duration: expect.closeTo(0.2),
        },
      ]);
    }
  );

  it("reads a trimmed frame's offset and untrimmed size", () => {
    const sheet = decode({
      frames: [
        {
          filename: "gem",
          frame: { x: 2, y: 3, w: 4, h: 5 },
          trimmed: true,
          spriteSourceSize: { x: 6, y: 7, w: 4, h: 5 },
          sourceSize: { w: 16, h: 16 },
          duration: 100,
        },
      ],
      meta: { image: "a.png", size: { w: 8, h: 8 } },
    });
    expect(sheet.frames[0]).toMatchObject({
      x: 2,
      y: 3,
      width: 4,
      height: 5,
      offsetX: 6,
      offsetY: 7,
      sourceWidth: 16,
      sourceHeight: 16,
    });
    expect(sheet.tags.size).toBe(0);
  });

  it("defaults a missing duration to Aseprite's 100 ms and a missing name to the index", () => {
    const sheet = decode({
      frames: [{ frame: { x: 0, y: 0, w: 8, h: 8 } }],
      meta: { image: "a.png", size: { w: 8, h: 8 } },
    });
    expect(sheet.frames[0]?.duration).toBe(0.1);
    expect(sheet.frameByName.get("0")).toBe(0);
  });

  it.each([
    { problem: "is not an object", json: "nope", says: "sprites/sheet.json" },
    {
      problem: "has no meta.image",
      json: { frames: [], meta: { size: { w: 1, h: 1 } } },
      says: "image",
    },
    {
      problem: "has no frames",
      json: { frames: [], meta: { image: "a.png", size: { w: 8, h: 8 } } },
      says: "no frames",
    },
    {
      problem: "has a frame outside the image",
      json: {
        frames: [frame(56)],
        meta: { image: "a.png", size: { w: 64, h: 16 } },
      },
      says: "frame 0 (0) at 56,0 size 16x16 lies outside the 64x16 image",
    },
    {
      problem: "has a rotated frame",
      json: {
        frames: [{ ...frame(0), rotated: true }],
        meta: { image: "a.png", size: { w: 64, h: 16 } },
      },
      says: "rotated",
    },
    {
      problem: "has a frame that lasts 0 ms",
      json: {
        frames: [frame(0, 0)],
        meta: { image: "a.png", size: { w: 64, h: 16 } },
      },
      says: "lasts 0 ms",
    },
    {
      problem: "has a tag past the last frame",
      json: {
        ...ARRAY_FORM,
        meta: { ...META, frameTags: [{ name: "x", from: 2, to: 4 }] },
      },
      says: 'tag "x" runs from frame 2 to 4, but the sheet has frames 0 to 3',
    },
    {
      problem: "has two tags with one name",
      json: {
        ...ARRAY_FORM,
        meta: {
          ...META,
          frameTags: [
            { name: "x", from: 0, to: 1 },
            { name: "x", from: 2, to: 3 },
          ],
        },
      },
      says: 'two tags are named "x"',
    },
    {
      problem: "has an unknown tag direction",
      json: {
        ...ARRAY_FORM,
        meta: {
          ...META,
          frameTags: [{ name: "x", from: 0, to: 1, direction: "sideways" }],
        },
      },
      says: "direction",
    },
  ])(
    "fails with a SpriteSheetError naming the file when it $problem",
    ({ json, says }) => {
      const error = decodeError(json);
      expect(error).toBeInstanceOf(SpriteSheetError);
      expect(error.file).toBe("sprites/sheet.json");
      expect(error.message).toContain("sprites/sheet.json");
      expect(error.message).toContain(says);
    }
  );
});

describe(frameAt, () => {
  // Frames 0 to 3 lasting 0.1, 0.2, 0.1 and 0.3 s, with one tag of each direction over all four.
  const sheet: SpriteSheetData = decode({
    frames: [frame(0, 100), frame(16, 200), frame(32, 100), frame(48, 300)],
    meta: {
      image: "a.png",
      size: { w: 64, h: 16 },
      frameTags: [
        { name: "forward", from: 0, to: 3, direction: "forward" },
        { name: "reverse", from: 0, to: 3, direction: "reverse" },
        { name: "pingpong", from: 0, to: 3, direction: "pingpong" },
        {
          name: "pingpong_reverse",
          from: 0,
          to: 3,
          direction: "pingpong_reverse",
        },
        { name: "still", from: 2, to: 2 },
        { name: "middle", from: 1, to: 2 },
      ],
    },
  });
  const tag = (name: string) => {
    const found = sheet.tags.get(name);
    if (!found) {
      throw new Error(`no tag ${name}`);
    }
    return found;
  };
  /** The frame shown at each time. */
  const play = (name: string, times: readonly number[]) =>
    times.map((seconds) => frameAt(sheet, tag(name), seconds));

  // Times stay off the edges between frames, where rounding could go either way.
  it("plays forward by each frame's duration, looping", () => {
    expect(tag("forward").duration).toBeCloseTo(0.7);
    expect(
      play("forward", [0, 0.05, 0.15, 0.29, 0.35, 0.45, 0.69, 0.75])
    ).toStrictEqual([0, 0, 1, 1, 2, 3, 3, 0]);
  });

  it("plays in reverse", () => {
    expect(play("reverse", [0, 0.29, 0.35, 0.45, 0.65, 0.75])).toStrictEqual([
      3, 3, 2, 1, 0, 3,
    ]);
  });

  it("plays pingpong without repeating the ends", () => {
    // 0 (0.1) 1 (0.2) 2 (0.1) 3 (0.3) 2 (0.1) 1 (0.2): 1.0 s.
    expect(tag("pingpong").duration).toBeCloseTo(1);
    expect(
      play("pingpong", [0, 0.15, 0.35, 0.5, 0.75, 0.85, 1.05])
    ).toStrictEqual([0, 1, 2, 3, 2, 1, 0]);
  });

  it("plays pingpong_reverse from the last frame", () => {
    // 3 (0.3) 2 (0.1) 1 (0.2) 0 (0.1) 1 (0.2) 2 (0.1): 1.0 s.
    expect(
      play("pingpong_reverse", [0, 0.35, 0.45, 0.65, 0.75, 0.95, 1.05])
    ).toStrictEqual([3, 2, 1, 0, 1, 2, 3]);
  });

  it("keeps to the tag's own frames", () => {
    expect(play("middle", [0, 0.25, 0.35])).toStrictEqual([1, 2, 1]);
    expect(play("still", [0, 5])).toStrictEqual([2, 2]);
  });

  it("counts a negative time back from the end of a loop", () => {
    expect(frameAt(sheet, tag("forward"), -0.1)).toBe(3);
  });
});
