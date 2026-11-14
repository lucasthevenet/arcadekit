/**
 * Sprite sheets: one image of pixel art and the JSON Aseprite exports for it, its frames and its
 * tags, with the image as a texture a view draws from.
 *
 * A sheet is loaded by the app and owned by it: a game declares it as an `Asset`,
 * whose layer loads it with `fromUrl` and frees it with `dispose` when the app ends, and a view
 * draws from it but never frees it. Loading is an Effect, which fails with a typed
 * `SpriteSheetError` and aborts its requests when interrupted. What a view reads of a sheet
 * (`frameAt`, `resolveTags`) is plain data work, called inside its frame or when it is made.
 *
 * @since 0.7.0
 */
import { Effect, Inspectable, Pipeable, Predicate, Schema } from "effect";
import type { Cause, Types } from "effect";
import { dual } from "effect/Function";
import * as THREE from "three";

import { keepTexture } from "./stage";

const TypeId = "~arcadekit/render-three/SpriteSheet";

/** The class `Schema.TaggedError` makes for `SpriteSheetError`, written out for isolatedDeclarations. */
type SpriteSheetErrorClass = Schema.Class<
  SpriteSheetError,
  Schema.TaggedStruct<
    "SpriteSheetError",
    {
      readonly file: Schema.String;
      readonly message: Schema.String;
      readonly cause: Schema.optional<Schema.Defect>;
    }
  >,
  Cause.YieldableError
>;

// Named so the type files can be made one file at a time (isolatedDeclarations).
const SpriteSheetErrorBase: SpriteSheetErrorClass =
  // oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError makes a class; it is not an error being thrown.
  Schema.TaggedError<SpriteSheetError>()("SpriteSheetError", {
    file: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  });

/**
 * A sprite sheet that couldn't be fetched, decoded or checked: `file` is the JSON or the image
 * that failed, and `message` says why, for the app to show.
 *
 * **When to use**
 *
 * An app catches it by its tag, `Effect.catchTag("SpriteSheetError", ...)`, to show a failed
 * load on its loading screen; a test makes one to stand in for a load that fails.
 *
 * **Details**
 *
 * `cause` is what was thrown, when the load wraps a throw (a failed `fetch`, an image the
 * browser can't decode): it is for a log, and the `message` is for the player.
 *
 * **Example** (A sheet with no frames)
 *
 * ```ts
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { Effect } from "effect";
 *
 * const json = { frames: [], meta: { image: "race.png", size: { w: 16, h: 16 } } };
 * const error = Effect.runSync(Effect.flip(SpriteSheet.decode("race.json", json)));
 * [error._tag, error.file]; // => ["SpriteSheetError", "race.json"]
 * error.message; // => "The sprite sheet race.json is invalid: it has no frames"
 * ```
 *
 * @category errors
 * @since 0.7.0
 */
export class SpriteSheetError extends SpriteSheetErrorBase {}

/**
 * How a tag's frames play: Aseprite's tag directions.
 *
 * **When to use**
 *
 * To read a tag's `direction`. `frameAt` plays each, and a view needs it only to draw a tag
 * some other way.
 *
 * **Details**
 *
 * A pingpong over frames 0 to 3 plays 0 1 2 3 2 1, and a pingpong_reverse 3 2 1 0 1 2.
 *
 * **Example** (A tag's direction)
 *
 * ```ts
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const { data } = TestSpriteSheet.fromTags({ "slime/move": 2 });
 * const direction: SpriteSheet.TagDirection | undefined =
 *   data.tags.get("slime/move")?.direction;
 * direction; // => "forward"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type TagDirection =
  | "forward"
  | "reverse"
  | "pingpong"
  | "pingpong_reverse";

/**
 * One frame of a sheet: where its pixels are in the image, where they sit in the untrimmed
 * frame, and how long it shows. Every size and offset is in sprite pixels.
 *
 * **When to use**
 *
 * To read a frame's size or place, as a shader of a game's own that draws from the sheet does.
 *
 * **Example** (A frame's place in the image)
 *
 * ```ts
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const { data } = TestSpriteSheet.fromTags({ floor: 2 });
 * const second: SpriteSheet.Frame | undefined = data.frames[1];
 * [second?.name, second?.x, second?.width]; // => ["floor 1", 16, 16]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Frame {
  /** Aseprite's `filename`, or the frame's key in the "hash" form. */
  readonly name: string;
  /** Where the frame's pixels are in the image, from its top-left corner. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Where those pixels sit in the untrimmed frame. 0, 0 unless the export trimmed it. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** The untrimmed frame's size: what an anchor is a fraction of. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** How long the frame shows in an animation, in seconds (Aseprite writes ms). */
  readonly duration: number;
}

/**
 * A tag: a named run of frames that is one animation, such as `"slime/move"`.
 *
 * **When to use**
 *
 * As what `resolveTags` gives under each of a view's names, which `frameAt` plays: a view keeps
 * them and reads `from` for a tag's first frame.
 *
 * **Details**
 *
 * `from` and `to` are frame indices, both included. `duration` is one whole loop, in seconds:
 * a pingpong loop plays its middle frames twice.
 *
 * **Example** (A tag of four frames)
 *
 * ```ts
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const { data } = TestSpriteSheet.fromTags({ floor: 3, "hero/walk": 4 });
 * const walk: SpriteSheet.Tag | undefined = data.tags.get("hero/walk");
 * [walk?.from, walk?.to]; // => [3, 6]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Tag {
  readonly name: string;
  /** First and last frame index, both included. */
  readonly from: number;
  readonly to: number;
  readonly direction: TagDirection;
  /** One whole loop, in seconds. A pingpong loop plays the middle frames twice. */
  readonly duration: number;
}

/**
 * A sheet's decoded JSON: its frames in order, a lookup by frame name, and its tags by name.
 *
 * **When to use**
 *
 * What a view reads its frames and tags from (`sheet.data`), and what a game's test decodes
 * from its real file with `decode` to check it, where no image is loaded.
 *
 * **Details**
 *
 * It is checked when decoded: every frame inside the image, every tag inside the frames, no two
 * tags with one name. If two frames share a name, `frameByName` has the first.
 *
 * **Example** (A sheet's size and frames)
 *
 * ```ts
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const data: SpriteSheet.Data = TestSpriteSheet.fromTags({ floor: 3 }).data;
 * [data.image, data.width, data.height]; // => ["test.png", 48, 16]
 * data.frameByName.get("floor 2"); // => 2
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Data {
  /** `meta.image` as written: the image's path relative to the JSON. */
  readonly image: string;
  /** The image's size in pixels (`meta.size`). */
  readonly width: number;
  readonly height: number;
  readonly frames: readonly Frame[];
  /** Frame index by name. If two frames share a name, the first wins. */
  readonly frameByName: ReadonlyMap<string, number>;
  readonly tags: ReadonlyMap<string, Tag>;
}

/**
 * Each name a view draws with its tag, or the tags to try in order. An `undefined` is skipped.
 *
 * **When to use**
 *
 * To name what a view draws, once, as a constant: `resolveTags` picks each from a sheet, and a
 * test checks a sheet against the same object.
 *
 * **Details**
 *
 * Write it `as const`, so each name is a key of what `resolveTags` gives. An `undefined` is for
 * a content entry that may name no sprite of its own: `[def.sprite, "enemy/move"]`.
 *
 * **Example** (A view's tags, with fallbacks)
 *
 * ```ts
 * import type { SpriteSheet } from "arcadekit/render-three";
 *
 * const WORLD_TAGS = {
 *   slime: "slime/move",
 *   heroWalk: ["hero/walk", "hero/idle"],
 * } as const satisfies SpriteSheet.WantedTags;
 * Object.keys(WORLD_TAGS); // => ["slime", "heroWalk"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type WantedTags = Readonly<
  Record<string, string | readonly (string | undefined)[]>
>;

/**
 * What `resolveTags` gives: a tag under each of a view's names, and the tags the sheet lacks.
 *
 * **When to use**
 *
 * To type the tags a view keeps, as `SpriteSheet.ResolvedTags<typeof WORLD_TAGS>["tags"]`.
 *
 * **Example** (The tags a view keeps)
 *
 * ```ts
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const WORLD_TAGS = { slime: "slime/move" } as const;
 * const { data } = TestSpriteSheet.fromTags({ "slime/move": 2 });
 * const tags: SpriteSheet.ResolvedTags<typeof WORLD_TAGS>["tags"] =
 *   SpriteSheet.resolveTags(data, WORLD_TAGS).tags;
 * tags.slime.name; // => "slime/move"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface ResolvedTags<Wanted extends WantedTags> {
  /** The first choice the sheet has, or a tag named "" that shows frame 0. */
  readonly tags: { readonly [K in keyof Wanted]: Tag };
  /** Every choice tried and not found, once each, in the order tried. */
  readonly missing: readonly string[];
}

/**
 * A sprite sheet ready to draw: its decoded JSON, and its image as a texture.
 *
 * **When to use**
 *
 * What a view draws from: its batches and tile layers are made from it, and its `data` gives
 * the tags. The app loads it and owns it, as a game's `Asset`.
 *
 * **Details**
 *
 * Its texture has nearest filtering, no mipmaps, sRGB colours and `flipY` off, so row 0 of the
 * image is v = 0; it is kept (`Stage.keepTexture`), so a view's `Stage.dispose` leaves it to
 * the app, which frees it with `dispose`.
 *
 * **Example** (A sheet's data and texture)
 *
 * ```ts
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const sheet: SpriteSheet.SpriteSheet = TestSpriteSheet.fromTags({ floor: 3 });
 * [sheet.data.frames.length, sheet.texture.name]; // => [3, "test.png"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface SpriteSheet
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  readonly data: Data;
  /** Nearest filtering, no mipmaps, sRGB, `flipY` off: row 0 of the image is v = 0. */
  readonly texture: THREE.Texture;
}

/** What the module's functions keep, which no caller reads. */
type Internal = Types.Mutable<SpriteSheet> & {
  /** The image the texture was made from, closed with it if it is a bitmap. */
  readonly image: TexImageSource;
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: SpriteSheet) {
    return {
      _id: "SpriteSheet",
      image: this.data.image,
      size: [this.data.width, this.data.height],
      frames: this.data.frames.length,
      tags: [...this.data.tags.keys()],
    };
  },
};

/**
 * Checks whether a value is a sprite sheet.
 *
 * **When to use**
 *
 * Narrow an unknown value before drawing from it.
 *
 * **Details**
 *
 * A sheet's `data` alone is none: it has no texture.
 *
 * **Example** (Recognising a sheet)
 *
 * ```ts
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const sheet = TestSpriteSheet.fromTags({ floor: 1 });
 * SpriteSheet.isSpriteSheet(sheet); // => true
 * SpriteSheet.isSpriteSheet(sheet.data); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isSpriteSheet = (value: unknown): value is SpriteSheet =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a sheet from its decoded data and an image that's already in memory, such as a canvas
 * the art was painted on.
 *
 * **When to use**
 *
 * For a sheet the app makes itself: art painted in code, or a test's stand-in image. `fromUrl`
 * uses it once it has fetched both files.
 *
 * **Details**
 *
 * The texture is named after `data.image` and kept (`Stage.keepTexture`). The image is read when
 * a renderer first uploads the texture, so it must be `data.width` by `data.height`.
 *
 * **Example** (A sheet from a canvas)
 *
 * ```ts
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { Effect } from "effect";
 *
 * const data = Effect.runSync(
 *   SpriteSheet.decode("painted.json", {
 *     frames: [{ frame: { x: 0, y: 0, w: 16, h: 16 } }],
 *     meta: { image: "painted.png", size: { w: 16, h: 16 } },
 *   })
 * );
 * const sheet = SpriteSheet.make(data, document.createElement("canvas"));
 * sheet.texture.name; // => "painted.png"
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (data: Data, image: TexImageSource): SpriteSheet => {
  const texture = new THREE.Texture(image);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.premultiplyAlpha = false;
  texture.name = data.image;
  texture.needsUpdate = true;
  keepTexture(texture);
  const self = Object.create(Proto) as Types.Mutable<Internal>;
  self.data = data;
  self.texture = texture;
  self.image = image;
  return self;
};

/**
 * Frees a sheet's texture, and its image if it is a bitmap.
 *
 * **When to use**
 *
 * As the `release` of the game's sheet `Asset`, which the app's end runs. A view never calls
 * it: the sheet is the app's.
 *
 * **Example** (The release of a game's sheet)
 *
 * ```ts
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const sheet = TestSpriteSheet.fromTags({ floor: 1 });
 * let freed = 0;
 * sheet.texture.addEventListener("dispose", () => {
 *   freed += 1;
 * });
 * SpriteSheet.dispose(sheet);
 * freed; // => 1
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const dispose = (self: SpriteSheet): void => {
  const { image, texture } = self as Internal;
  texture.dispose();
  if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
    image.close();
  }
};

const Count = Schema.Int;
const Rect = Schema.Struct({ x: Count, y: Count, w: Count, h: Count });
const Size = Schema.Struct({ w: Count, h: Count });
const AsepriteFrame = Schema.Struct({
  filename: Schema.optional(Schema.String),
  frame: Rect,
  rotated: Schema.optional(Schema.Boolean),
  spriteSourceSize: Schema.optional(Rect),
  sourceSize: Schema.optional(Size),
  duration: Schema.optional(Schema.Finite),
});
type AsepriteFrame = typeof AsepriteFrame.Type;
const AsepriteSheet = Schema.Struct({
  frames: Schema.Union([
    Schema.Array(AsepriteFrame),
    Schema.Record(Schema.String, AsepriteFrame),
  ]),
  meta: Schema.Struct({
    image: Schema.String,
    size: Size,
    frameTags: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          from: Count,
          to: Count,
          direction: Schema.optional(
            Schema.Literals([
              "forward",
              "reverse",
              "pingpong",
              "pingpong_reverse",
            ])
          ),
        })
      )
    ),
  }),
});
const decodeAseprite = Schema.decodeUnknownEffect(AsepriteSheet);

/** Aseprite's default frame duration, in ms, for exports that leave it out. */
const DEFAULT_DURATION_MS = 100;

const invalid = (file: string, message: string): SpriteSheetError =>
  new SpriteSheetError({
    file,
    message: `The sprite sheet ${file} is invalid: ${message}`,
  });

/**
 * Decodes an Aseprite JSON export, with its frames as an array or a hash, and checks it: every
 * frame inside the image, every tag inside the frames, no two tags with one name.
 *
 * **When to use**
 *
 * In a game's test, on the JSON of the sheet it ships, to check its tags and its PNG with no
 * image loaded. `fromUrl` decodes what it fetches with it.
 *
 * **Details**
 *
 * `file` names the JSON in the error, which says what is wrong: a frame outside the image, a
 * rotated frame (a TexturePacker option, unsupported), a frame that lasts no time, a tag past
 * the last frame, two tags with one name, or JSON that is no sheet. A frame with no `duration`
 * lasts Aseprite's 100 ms, and one with no `filename` is named by its index. A tag's `repeat`
 * is ignored: animations loop.
 *
 * **Example** (Decoding a sheet of two frames)
 *
 * ```ts
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { Effect } from "effect";
 *
 * const data = Effect.runSync(
 *   SpriteSheet.decode("hero.json", {
 *     frames: [
 *       { filename: "walk 0", frame: { x: 0, y: 0, w: 16, h: 16 } },
 *       { filename: "walk 1", frame: { x: 16, y: 0, w: 16, h: 16 } },
 *     ],
 *     meta: {
 *       image: "hero.png",
 *       size: { w: 32, h: 16 },
 *       frameTags: [{ name: "hero/walk", from: 0, to: 1 }],
 *     },
 *   })
 * );
 * data.frames.map((frame) => frame.name); // => ["walk 0", "walk 1"]
 * data.tags.get("hero/walk")?.duration; // => 0.2
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const decode: (
  file: string,
  json: unknown
) => Effect.Effect<Data, SpriteSheetError> = Effect.fn("SpriteSheet.decode")(
  function* (
    file: string,
    json: unknown
  ): Effect.fn.Return<Data, SpriteSheetError> {
    const sheet = yield* decodeAseprite(json).pipe(
      Effect.mapError((error) => invalid(file, error.message))
    );
    const { meta } = sheet;
    if (meta.size.w < 1 || meta.size.h < 1) {
      return yield* invalid(file, `meta.size is ${meta.size.w}x${meta.size.h}`);
    }
    const entries: (readonly [string, AsepriteFrame])[] = Array.isArray(
      sheet.frames
    )
      ? sheet.frames.map(
          (frame, index) => [frame.filename ?? String(index), frame] as const
        )
      : Object.entries(sheet.frames);
    if (entries.length === 0) {
      return yield* invalid(file, "it has no frames");
    }

    const frames: Frame[] = [];
    const frameByName = new Map<string, number>();
    for (const [name, frame] of entries) {
      const problem = frameProblem(frame, meta.size);
      if (problem !== undefined) {
        return yield* invalid(
          file,
          `frame ${frames.length} (${name}) ${problem}`
        );
      }
      const { x, y, w, h } = frame.frame;
      const placed = frame.spriteSourceSize ?? { x: 0, y: 0, w, h };
      const source = frame.sourceSize ?? { w, h };
      if (!frameByName.has(name)) {
        frameByName.set(name, frames.length);
      }
      frames.push({
        name,
        x,
        y,
        width: w,
        height: h,
        offsetX: placed.x,
        offsetY: placed.y,
        sourceWidth: source.w,
        sourceHeight: source.h,
        duration: (frame.duration ?? DEFAULT_DURATION_MS) / 1000,
      });
    }

    const tags = readTags(meta.frameTags ?? [], frames);
    if (typeof tags === "string") {
      return yield* invalid(file, tags);
    }

    return {
      image: meta.image,
      width: meta.size.w,
      height: meta.size.h,
      frames,
      frameByName,
      tags,
    };
  }
);

/** Why a file of a sheet couldn't be fetched, for its error's message. */
const failedLoad = (file: string, why: string, cause?: unknown) =>
  new SpriteSheetError({
    file,
    message: `The sprite sheet file ${file} can't be loaded: ${why}`,
    ...(cause === undefined ? {} : { cause }),
  });

const reason = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Fetches a file of a sheet and reads its body. One request, aborted when interrupted, whether
 * it waits on the response or on the body; a response that isn't a success is a failure.
 */
const fetchFile = Effect.fnUntraced(function* <A>(
  file: string,
  read: (response: Response) => Promise<A>
): Effect.fn.Return<A, SpriteSheetError> {
  const got = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(file, { signal });
      return response.ok
        ? { read: true as const, body: await read(response) }
        : { read: false as const, status: response.status };
    },
    catch: (cause) => failedLoad(file, reason(cause), cause),
  });
  if (!got.read) {
    return yield* failedLoad(file, `HTTP ${got.status}`);
  }
  return got.body;
});

/**
 * Decodes an image file's bytes into a bitmap. An interrupted decode can't be stopped, so the
 * bitmap it makes after all is closed when it arrives.
 */
const decodeImage = (
  file: string,
  blob: Blob
): Effect.Effect<ImageBitmap, SpriteSheetError> =>
  Effect.callback<ImageBitmap, SpriteSheetError>((resume, signal) => {
    createImageBitmap(blob, {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    })
      .then((image) =>
        // An interrupted load has ended: the bitmap it decoded after all is no one's.
        signal.aborted ? image.close() : resume(Effect.succeed(image))
      )
      .catch((error: unknown) => {
        resume(Effect.fail(failedLoad(file, reason(error), error)));
      });
  });

/**
 * Loads a sheet: fetches the JSON at `jsonUrl`, then the image its `meta.image` names, relative
 * to the JSON, and makes the sheet from both.
 *
 * **When to use**
 *
 * In the app, as what the game's sheet `Asset` loads: `MySheet.layer(SpriteSheet.fromUrl(url))`.
 * The asset keeps its first success, and its loading screen runs it again after a failure.
 *
 * **Details**
 *
 * Making the Effect fetches nothing: each run fetches both files again. It fails with a
 * `SpriteSheetError` that names the file when either can't be fetched (with what `fetch` threw
 * as its `cause`), a response isn't a success (with its HTTP status), the JSON is no sheet, the
 * image can't be decoded, or its size isn't `meta.size`. Interrupting it aborts the request it
 * has open, and closes the image it was decoding. A trace shows it as `SpriteSheet.fromUrl`.
 *
 * **Example** (The app's sheet, served beside it)
 *
 * ```ts
 * import { Asset } from "arcadekit/content";
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { Effect, Layer } from "effect";
 *
 * class RaceSheet extends Asset<
 *   SpriteSheet.SpriteSheet,
 *   SpriteSheet.SpriteSheetError
 * >()("RaceSheet", { release: SpriteSheet.dispose }) {}
 *
 * // Making the load and the layer fetches nothing.
 * const load = SpriteSheet.fromUrl("/sprites/race.json");
 * Effect.isEffect(load); // => true
 * Layer.isLayer(RaceSheet.layer(load)); // => true
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const fromUrl: (
  jsonUrl: string
) => Effect.Effect<SpriteSheet, SpriteSheetError> = Effect.fn(
  "SpriteSheet.fromUrl"
)(function* (jsonUrl: string): Effect.fn.Return<SpriteSheet, SpriteSheetError> {
  const json = yield* fetchFile(jsonUrl, (response): Promise<unknown> =>
    response.json()
  );
  const data = yield* decode(jsonUrl, json);
  const imageUrl = new URL(
    data.image,
    new URL(jsonUrl, globalThis.location.href)
  ).href;
  const blob = yield* fetchFile(imageUrl, (response) => response.blob());
  const image = yield* decodeImage(imageUrl, blob);
  const { width, height } = image;
  if (width !== data.width || height !== data.height) {
    image.close();
    return yield* new SpriteSheetError({
      file: imageUrl,
      message: `The sprite sheet image ${imageUrl} is ${width}x${height}, but ${jsonUrl} says ${data.width}x${data.height}`,
    });
  }
  return make(data, image);
});

/** The tags by name, or what's wrong with them. */
const readTags = (
  frameTags: readonly {
    readonly name: string;
    readonly from: number;
    readonly to: number;
    readonly direction?: TagDirection | undefined;
  }[],
  frames: readonly Frame[]
): Map<string, Tag> | string => {
  const tags = new Map<string, Tag>();
  for (const tag of frameTags) {
    if (tags.has(tag.name)) {
      return `two tags are named "${tag.name}"`;
    }
    if (tag.from < 0 || tag.from > tag.to || tag.to >= frames.length) {
      return `tag "${tag.name}" runs from frame ${tag.from} to ${tag.to}, but the sheet has frames 0 to ${frames.length - 1}`;
    }
    const shape = {
      from: tag.from,
      to: tag.to,
      direction: tag.direction ?? "forward",
    };
    let duration = 0;
    for (let step = 0; step < loopLength(shape); step += 1) {
      duration += frames[frameOfStep(shape, step)]?.duration ?? 0;
    }
    tags.set(tag.name, { name: tag.name, ...shape, duration });
  }
  return tags;
};

/** What's wrong with one frame, or undefined. */
const frameProblem = (
  frame: AsepriteFrame,
  image: { readonly w: number; readonly h: number }
): string | undefined => {
  const { x, y, w, h } = frame.frame;
  if (frame.rotated === true) {
    return "is rotated, which isn't supported";
  }
  if (w < 1 || h < 1) {
    return `is ${w}x${h}`;
  }
  if (x < 0 || y < 0 || x + w > image.w || y + h > image.h) {
    return `at ${x},${y} size ${w}x${h} lies outside the ${image.w}x${image.h} image`;
  }
  if (frame.duration !== undefined && frame.duration <= 0) {
    return `lasts ${frame.duration} ms`;
  }
  const placed = frame.spriteSourceSize;
  const source = frame.sourceSize ?? { w, h };
  if (
    placed !== undefined &&
    (placed.x < 0 ||
      placed.y < 0 ||
      placed.x + w > source.w ||
      placed.y + h > source.h)
  ) {
    return `is placed at ${placed.x},${placed.y} outside its ${source.w}x${source.h} source size`;
  }
  return undefined;
};

type TagShape = Pick<Tag, "from" | "to" | "direction">;

const isPingpong = (tag: TagShape) =>
  tag.direction === "pingpong" || tag.direction === "pingpong_reverse";

/** Frames in one loop: a pingpong over 0..3 plays 0 1 2 3 2 1. */
const loopLength = (tag: TagShape): number => {
  const count = tag.to - tag.from + 1;
  return isPingpong(tag) && count > 1 ? 2 * count - 2 : count;
};

/** The frame index shown at `step` of a loop. */
const frameOfStep = (tag: TagShape, step: number): number => {
  const count = tag.to - tag.from + 1;
  const back = step - count + 1;
  switch (tag.direction) {
    case "forward": {
      return tag.from + step;
    }
    case "reverse": {
      return tag.to - step;
    }
    case "pingpong": {
      return step < count ? tag.from + step : tag.to - back;
    }
    case "pingpong_reverse": {
      return step < count ? tag.to - step : tag.from + back;
    }
  }
};

/**
 * The frame index (into `data.frames`) a tag shows `seconds` into its animation, looping, from
 * each frame's duration and the tag's direction.
 *
 * **When to use**
 *
 * Per sprite per frame, with the view's time, to pick what a batch pushes: it allocates
 * nothing. A walk played from its first frame takes the time since it began (`gait.since`).
 *
 * **Details**
 *
 * A negative time counts back from the end of a loop. A tag of one frame, or of no duration,
 * shows its first frame.
 *
 * **Example** (A walk of four frames of 100 ms)
 *
 * ```ts
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const { data } = TestSpriteSheet.fromTags({ "hero/walk": 4 });
 * const walk = SpriteSheet.resolveTags(data, { walk: "hero/walk" }).tags.walk;
 * SpriteSheet.frameAt(data, walk, 0.25); // => 2
 * // Looping: 0.45 s into a 0.4 s loop.
 * SpriteSheet.frameAt(data, walk, 0.45); // => 0
 * SpriteSheet.frameAt(data, walk, -0.05); // => 3
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const frameAt: {
  (tag: Tag, seconds: number): (self: Data) => number;
  (self: Data, tag: Tag, seconds: number): number;
} = dual(3, (self: Data, tag: Tag, seconds: number): number => {
  if (tag.from === tag.to || !(tag.duration > 0)) {
    return tag.from;
  }
  let left = seconds % tag.duration;
  if (left < 0) {
    left += tag.duration;
  }
  const steps = loopLength(tag);
  for (let step = 0; step < steps; step += 1) {
    const index = frameOfStep(tag, step);
    left -= self.frames[index]?.duration ?? 0;
    if (left < 0) {
      return index;
    }
  }
  // Rounding can leave a hair of time past the last step.
  return frameOfStep(tag, steps - 1);
});

/** Shows frame 0: what a name draws when the sheet has none of its choices. */
const FRAME_ZERO: Tag = {
  name: "",
  from: 0,
  to: 0,
  direction: "forward",
  duration: 0,
};

const quoted = (names: Iterable<string>): string =>
  [...names].map((name) => `"${name}"`).join(", ");

/**
 * Picks the tag of each name a view draws: the first of the name's choices that the sheet has.
 * A name with none of them gets a tag named `""` that shows frame 0, so a view never tests for
 * a missing tag.
 *
 * **When to use**
 *
 * Once, when the view is made, or once per run for tags that come from the run's content; never
 * per frame, since it allocates. A game's test checks its sheet with `missing`.
 *
 * **Details**
 *
 * A choice after the one found is not tried, and an `undefined` among the choices is skipped.
 * `missing` is every choice tried and not found, once each, in the order tried. A call that
 * misses warns once on the console, naming the sheet's image and each tag in `missing`, so a
 * game that draws the wrong sprite says why. The same warning names each name that was given
 * no tag to try (an empty list, or one of `undefined`s alone): it draws frame 0 too, and is in
 * no `missing`, since no sheet could have its tag.
 *
 * **Example** (A view's tags, one of them missing)
 *
 * ```ts
 * import { SpriteSheet } from "arcadekit/render-three";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 *
 * const { data } = TestSpriteSheet.fromTags({ wall: 1, floor: 3 });
 * // Warns once that the sheet has no tag "wall/face".
 * const { tags, missing } = SpriteSheet.resolveTags(data, {
 *   floor: "floor",
 *   wallFace: ["wall/face", "wall"],
 * });
 * [tags.floor.from, tags.wallFace.name]; // => [1, "wall"]
 * missing; // => ["wall/face"]
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const resolveTags: {
  <const Wanted extends WantedTags>(
    wanted: Wanted
  ): (self: Data) => ResolvedTags<Wanted>;
  <const Wanted extends WantedTags>(
    self: Data,
    wanted: Wanted
  ): ResolvedTags<Wanted>;
} = dual(
  2,
  <const Wanted extends WantedTags>(
    self: Data,
    wanted: Wanted
  ): ResolvedTags<Wanted> => {
    const missing = new Set<string>();
    /** The names given no tag to try. */
    const bare: string[] = [];
    const resolved = Object.entries(wanted).map(
      ([key, choices]): [string, Tag] => {
        let tried = false;
        let found: Tag | undefined;
        for (const name of typeof choices === "string" ? [choices] : choices) {
          if (name !== undefined) {
            tried = true;
            found = self.tags.get(name);
            if (found !== undefined) {
              break;
            }
            missing.add(name);
          }
        }
        if (!tried) {
          bare.push(key);
        }
        return [key, found ?? FRAME_ZERO];
      }
    );
    const said: string[] = [];
    if (missing.size > 0) {
      said.push(
        `The sprite sheet ${self.image} has no tag ${quoted(missing)}: a name that asked for one draws its next choice, or frame 0 when it has none left.`
      );
    }
    if (bare.length > 0) {
      said.push(
        `No tag was given to try for ${quoted(bare)} in the sprite sheet ${self.image}: a name with none draws frame 0.`
      );
    }
    if (said.length > 0) {
      console.warn(said.join(" "));
    }
    return {
      // From entries, so that any key a map has is a name of its own, "__proto__" too.
      tags: Object.fromEntries(resolved) as {
        readonly [K in keyof Wanted]: Tag;
      },
      missing: [...missing],
    };
  }
);
