import { Effect, Fiber } from "effect";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import { SpriteSheet } from "../../src/render-three/index";

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
  Effect.runSync(SpriteSheet.decode("sprites/sheet.json", json));

const decodeError = (json: unknown): SpriteSheet.SpriteSheetError =>
  Effect.runSync(Effect.flip(SpriteSheet.decode("sprites/sheet.json", json)));

describe(SpriteSheet.decode, () => {
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
      expect(error).toBeInstanceOf(SpriteSheet.SpriteSheetError);
      expect(error.file).toBe("sprites/sheet.json");
      expect(error.message).toContain("sprites/sheet.json");
      expect(error.message).toContain(says);
    }
  );
});

describe(SpriteSheet.frameAt, () => {
  // Frames 0 to 3 lasting 0.1, 0.2, 0.1 and 0.3 s, with one tag of each direction over all four.
  const sheet: SpriteSheet.Data = decode({
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
    times.map((seconds) => SpriteSheet.frameAt(sheet, tag(name), seconds));

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
    expect(SpriteSheet.frameAt(sheet, tag("forward"), -0.1)).toBe(3);
  });
});

describe(SpriteSheet.resolveTags, () => {
  // Its tags are "slime/move" (frames 0 and 1) and "bat/fly" (2 and 3), in "sheet.png".
  const sheet = decode(ARRAY_FORM);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives each name the first of its choices the sheet has, and skips an undefined", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tags, missing } = SpriteSheet.resolveTags(sheet, {
      slime: "slime/move",
      bat: ["bat/fly", "slime/move"],
      // A content entry that names no sprite of its own.
      ghost: [undefined, "bat/fly"],
    });
    expect({
      slime: tags.slime === sheet.tags.get("slime/move"),
      bat: tags.bat.name,
      ghost: tags.ghost.name,
      missing,
      warned: warn.mock.calls.length,
    }).toStrictEqual({
      slime: true,
      bat: "bat/fly",
      ghost: "bat/fly",
      missing: [],
      warned: 0,
    });
    expectTypeOf(tags).toEqualTypeOf<{
      readonly slime: SpriteSheet.Tag;
      readonly bat: SpriteSheet.Tag;
      readonly ghost: SpriteSheet.Tag;
    }>();
    // @ts-expect-error "rat" is no name this view asked for.
    expect(tags.rat).toBeUndefined();
  });

  it("falls back along a name's choices, and gives a tag that shows frame 0 when none is found", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tags } = SpriteSheet.resolveTags(sheet, {
      ghost: ["ghost/move", "wraith/move", "bat/fly"],
      rat: ["rat/move", undefined, "mouse/move"],
      mole: "mole/move",
    });
    expect({
      ghost: tags.ghost.name,
      rat: tags.rat,
      mole: tags.mole,
      // It plays as any tag does: its one frame, at any time.
      frames: [
        SpriteSheet.frameAt(sheet, tags.rat, 0),
        SpriteSheet.frameAt(sheet, tags.rat, 5.3),
      ],
    }).toStrictEqual({
      ghost: "bat/fly",
      rat: { name: "", from: 0, to: 0, direction: "forward", duration: 0 },
      mole: { name: "", from: 0, to: 0, direction: "forward", duration: 0 },
      frames: [0, 0],
    });
  });

  it("lists each choice tried and not found once, in the order tried", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { missing } = SpriteSheet.resolveTags(sheet, {
      ghost: ["ghost/move", "wraith/move", "bat/fly"],
      // "wraith/move" was tried for the ghost: it is listed once.
      wraith: ["wraith/move", "slime/move"],
      rat: "rat/move",
      // The first choice is found, so the second is never tried.
      slime: ["slime/move", "blob/move"],
    });
    expect(missing).toStrictEqual(["ghost/move", "wraith/move", "rat/move"]);
  });

  it("warns once in a call that misses, naming the sheet's image and each missing tag", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    SpriteSheet.resolveTags(sheet, {
      ghost: ["ghost/move", "bat/fly"],
      rat: "rat/move",
    });
    expect(warn.mock.calls).toStrictEqual([
      [
        'The sprite sheet sheet.png has no tag "ghost/move", "rat/move": a name that asked for one draws its next choice, or frame 0 when it has none left.',
      ],
    ]);
    // Each call says what it missed: a view resolves once, and a game once per run.
    SpriteSheet.resolveTags(sheet, { rat: "rat/move" });
    SpriteSheet.resolveTags(sheet, { slime: "slime/move" });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("names in the same warning each name given no tag to try, which draws frame 0", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A content entry that names no sprite, in a view with no generic one to draw for it.
    const { tags, missing } = SpriteSheet.resolveTags(sheet, {
      boss: [undefined],
      mole: [],
      slime: "slime/move",
    });
    expect({
      boss: tags.boss.name,
      mole: tags.mole.name,
      missing,
    }).toStrictEqual(
      // No tag was tried, so the sheet lacks none.
      { boss: "", mole: "", missing: [] }
    );
    SpriteSheet.resolveTags(sheet, {
      boss: [undefined, undefined],
      rat: "rat/move",
    });
    expect(warn.mock.calls).toStrictEqual([
      [
        'No tag was given to try for "boss", "mole" in the sprite sheet sheet.png: a name with none draws frame 0.',
      ],
      [
        'The sprite sheet sheet.png has no tag "rat/move": a name that asked for one draws its next choice, or frame 0 when it has none left. No tag was given to try for "boss" in the sprite sheet sheet.png: a name with none draws frame 0.',
      ],
    ]);
  });

  it("gives a tag under every key of the map, whatever the key", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // A map read from a file can have any key: this one is no prototype here.
    const wanted = JSON.parse(
      '{ "__proto__": "bat/fly", "constructor": "rat/move" }'
    ) as Record<string, string>;
    const { tags } = SpriteSheet.resolveTags(sheet, wanted);
    expect(
      Object.entries(tags).map(([key, tag]) => [key, tag.name])
    ).toStrictEqual([
      ["__proto__", "bat/fly"],
      ["constructor", ""],
    ]);
  });
});

/** A bitmap as `createImageBitmap` gives one: its size, and how many times it was closed. */
const bitmap = (width: number, height: number) => ({
  width,
  height,
  closed: 0,
  close() {
    this.closed += 1;
  },
});

describe(SpriteSheet.fromUrl, () => {
  /** What the stand-in `fetch` was asked for, in order. */
  let requested: string[];
  /** The signal of each request, by its URL. */
  let signals: Map<string, AbortSignal>;

  /** Serves `files` by URL: JSON as itself, an image as a blob; anything else is a 404. */
  const serve = (files: Readonly<Record<string, unknown>>) => {
    vi.stubGlobal("location", { href: "https://game.test/play/" });
    vi.stubGlobal("fetch", (url: string, init?: { signal?: AbortSignal }) => {
      requested.push(url);
      if (init?.signal !== undefined) {
        signals.set(url, init.signal);
      }
      const file = files[url];
      if (file === "pending") {
        // oxlint-disable-next-line promise/avoid-new -- a request that never answers, as a stalled server's.
        return new Promise<never>(() => {});
      }
      return Promise.resolve(
        file === undefined
          ? { ok: false, status: 404 }
          : {
              ok: true,
              status: 200,
              json: () => Promise.resolve(file),
              blob: () => Promise.resolve(file),
            }
      );
    });
  };

  const IMAGE_URL = "https://game.test/play/sprites/sheet.png";

  beforeEach(() => {
    requested = [];
    signals = new Map();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the JSON, then the image it names beside it, and makes the sheet", async () => {
    serve({
      "sprites/sheet.json": ARRAY_FORM,
      [IMAGE_URL]: "the image's bytes",
    });
    const image = bitmap(64, 16);
    vi.stubGlobal("createImageBitmap", () => Promise.resolve(image));
    const sheet = await Effect.runPromise(
      SpriteSheet.fromUrl("sprites/sheet.json")
    );
    expect({
      requested,
      sheet: SpriteSheet.isSpriteSheet(sheet),
      frames: sheet.data.frames.length,
      texture: [sheet.texture.name, sheet.texture.image === image],
      closed: image.closed,
    }).toStrictEqual({
      requested: ["sprites/sheet.json", IMAGE_URL],
      sheet: true,
      frames: 4,
      texture: ["sheet.png", true],
      closed: 0,
    });
  });

  it("fails with a SpriteSheetError naming the file a response isn't a success for", async () => {
    serve({ "sprites/sheet.json": ARRAY_FORM });
    const error = await Effect.runPromise(
      Effect.flip(SpriteSheet.fromUrl("sprites/sheet.json"))
    );
    expect([error._tag, error.file, error.message]).toStrictEqual([
      "SpriteSheetError",
      IMAGE_URL,
      `The sprite sheet file ${IMAGE_URL} can't be loaded: HTTP 404`,
    ]);
  });

  it("fails with what fetch threw as its cause", async () => {
    vi.stubGlobal("location", { href: "https://game.test/play/" });
    const offline = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", () => Promise.reject(offline));
    const error = await Effect.runPromise(
      Effect.flip(SpriteSheet.fromUrl("sprites/sheet.json"))
    );
    expect([error.message, error.cause]).toStrictEqual([
      "The sprite sheet file sprites/sheet.json can't be loaded: Failed to fetch",
      offline,
    ]);
  });

  it("fails, and closes the image, when the image isn't the size the JSON says", async () => {
    serve({
      "sprites/sheet.json": ARRAY_FORM,
      [IMAGE_URL]: "the image's bytes",
    });
    const image = bitmap(32, 16);
    vi.stubGlobal("createImageBitmap", () => Promise.resolve(image));
    const error = await Effect.runPromise(
      Effect.flip(SpriteSheet.fromUrl("sprites/sheet.json"))
    );
    expect([error.file, error.message, image.closed]).toStrictEqual([
      IMAGE_URL,
      `The sprite sheet image ${IMAGE_URL} is 32x16, but sprites/sheet.json says 64x16`,
      1,
    ]);
  });

  it("aborts the request it has open when interrupted", async () => {
    serve({ "sprites/sheet.json": "pending" });
    const fiber = Effect.runFork(SpriteSheet.fromUrl("sprites/sheet.json"));
    await vi.waitFor(() => expect(requested).toHaveLength(1));
    const signal = signals.get("sprites/sheet.json");
    expect(signal?.aborted).toBe(false);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(signal?.aborted).toBe(true);
  });

  it("closes the image it was decoding when interrupted, once the decode ends", async () => {
    serve({
      "sprites/sheet.json": ARRAY_FORM,
      [IMAGE_URL]: "the image's bytes",
    });
    const image = bitmap(64, 16);
    let decoded = (_image: typeof image) => {};
    vi.stubGlobal(
      "createImageBitmap",
      () =>
        // oxlint-disable-next-line promise/avoid-new -- a decode that ends when the test says.
        new Promise((resolve) => {
          decoded = resolve;
        })
    );
    const fiber = Effect.runFork(SpriteSheet.fromUrl("sprites/sheet.json"));
    await vi.waitFor(() => expect(requested).toHaveLength(2));
    await Effect.runPromise(Fiber.interrupt(fiber));
    // A decode can't be stopped: its bitmap comes after the load has ended.
    expect(image.closed).toBe(0);
    decoded(image);
    await vi.waitFor(() => expect(image.closed).toBe(1));
  });
});
