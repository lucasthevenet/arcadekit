// Sprite sheet data: Aseprite's JSON export, parsed and checked. No DOM and no Three.js here,
// so it runs anywhere; the loader (sprite-loader.ts) adds the image and its texture.

import { Data, Effect, Result, Schema } from "effect";

/** A sprite sheet that couldn't be fetched, decoded or checked. `file` is the JSON or image that failed. */
export class SpriteSheetError extends Data.TaggedError("SpriteSheetError")<{
  readonly file: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** How a tag's frames play: Aseprite's tag directions. */
export type SpriteTagDirection =
  | "forward"
  | "reverse"
  | "pingpong"
  | "pingpong_reverse";

/** One frame of a sheet. Every size and offset is in sprite pixels. */
export interface SpriteFrame {
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

/** A named run of frames: one animation, such as "slime/move". */
export interface SpriteTag {
  readonly name: string;
  /** First and last frame index, both included. */
  readonly from: number;
  readonly to: number;
  readonly direction: SpriteTagDirection;
  /** One whole loop, in seconds. A pingpong loop plays the middle frames twice. */
  readonly duration: number;
}

/** A parsed sheet: its frames in order, a lookup by frame name, and its tags by name. */
export interface SpriteSheetData {
  /** `meta.image` as written: the image's path relative to the JSON. */
  readonly image: string;
  /** The image's size in pixels (`meta.size`). */
  readonly width: number;
  readonly height: number;
  readonly frames: readonly SpriteFrame[];
  /** Frame index by name. If two frames share a name, the first wins. */
  readonly frameByName: ReadonlyMap<string, number>;
  readonly tags: ReadonlyMap<string, SpriteTag>;
}

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
const decodeAseprite = Schema.decodeUnknownResult(AsepriteSheet);

/** Aseprite's default frame duration, in ms, for exports that leave it out. */
const DEFAULT_DURATION_MS = 100;

/**
 * Parses an Aseprite JSON export (frames as an array or a hash) and checks it: every frame
 * inside the image, every tag inside the frames, no two tags with one name. `file` names the
 * JSON in the error. Rotated frames (a TexturePacker option) aren't supported. A tag's
 * `repeat` is ignored: animations loop.
 */
export const decodeSpriteSheet = (
  file: string,
  json: unknown
): Effect.Effect<SpriteSheetData, SpriteSheetError> => {
  const fail = (message: string) =>
    Effect.fail(
      new SpriteSheetError({
        file,
        message: `The sprite sheet ${file} is invalid: ${message}`,
      })
    );
  const decoded = decodeAseprite(json);
  if (Result.isFailure(decoded)) {
    return fail(decoded.failure.message);
  }
  const { meta } = decoded.success;
  if (meta.size.w < 1 || meta.size.h < 1) {
    return fail(`meta.size is ${meta.size.w}x${meta.size.h}`);
  }
  const entries: (readonly [string, AsepriteFrame])[] = Array.isArray(
    decoded.success.frames
  )
    ? decoded.success.frames.map(
        (frame, index) => [frame.filename ?? String(index), frame] as const
      )
    : Object.entries(decoded.success.frames);
  if (entries.length === 0) {
    return fail("it has no frames");
  }

  const frames: SpriteFrame[] = [];
  const frameByName = new Map<string, number>();
  for (const [name, frame] of entries) {
    const problem = frameProblem(frame, meta.size);
    if (problem !== undefined) {
      return fail(`frame ${frames.length} (${name}) ${problem}`);
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
    return fail(tags);
  }

  return Effect.succeed({
    image: meta.image,
    width: meta.size.w,
    height: meta.size.h,
    frames,
    frameByName,
    tags,
  });
};

/** The tags by name, or what's wrong with them. */
const readTags = (
  frameTags: readonly {
    readonly name: string;
    readonly from: number;
    readonly to: number;
    readonly direction?: SpriteTagDirection | undefined;
  }[],
  frames: readonly SpriteFrame[]
): Map<string, SpriteTag> | string => {
  const tags = new Map<string, SpriteTag>();
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

type TagShape = Pick<SpriteTag, "from" | "to" | "direction">;

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
 * The frame index (into `sheet.frames`) a tag shows `seconds` into its animation, looping,
 * from each frame's duration and the tag's direction. Allocates nothing: call it per sprite
 * per frame. Negative times count back from the end of a loop.
 */
export const frameAt = (
  sheet: SpriteSheetData,
  tag: SpriteTag,
  seconds: number
): number => {
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
    left -= sheet.frames[index]?.duration ?? 0;
    if (left < 0) {
      return index;
    }
  }
  // Rounding can leave a hair of time past the last step.
  return frameOfStep(tag, steps - 1);
};
