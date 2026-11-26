/**
 * The component that gives each entity a colour of its own, which a renderer
 * reads to draw it. An entity's colour is the game's, as its position is, so
 * the game's systems write it and a renderer only reads it.
 *
 *   commands.spawn(
 *     Rock,
 *     Transform3d.Position.of({ x: 0, y: 4, z: 0 }),
 *     Color.Rgb.of(Color.hex(0xff6188))
 *   )
 *
 * It is an ordinary component of three 32-bit floats and the space they are
 * written in. The game's systems write it, and a save, the world's hash and a
 * replay hold it. Nothing here draws. `@arcadekit/three` draws an instance in
 * its entity's colour when its kind asks for one:
 * `Three.instances(name, { ..., color: Color.Rgb })`.
 *
 * A colour's numbers are written in one of two spaces, and its `space` says
 * which:
 *
 * - `Srgb` is a colour as a hex code or a colour picker writes it, each
 *   number from 0 to 1.
 * - `Linear` is a renderer's own numbers, in which light adds up. A number
 *   can be over 1, for a colour brighter than white.
 */
import type { Effect } from "effect";

import { Component, Field } from "./ecs/component.ts";
import type { Entity, FieldDef } from "./ecs/component.ts";
import type { EntityColumn } from "./ecs/query.ts";
import { Row, smoothing } from "./internal/smooth.ts";
import type { Frame, Time } from "./Services.ts";

/**
 * The space of a colour written as a hex code or a colour picker writes it,
 * each number from 0 to 1. `#ff6188` is an `r` of `0xff / 255`, a `g` of
 * `0x61 / 255` and a `b` of `0x88 / 255`.
 *
 * **When to use**
 *
 * Use for any colour a game picks, such as a team's. For a colour worked out
 * as light, or one brighter than white, use `Color.Linear`.
 *
 * **Gotchas**
 *
 * `@arcadekit/three` draws a number below 0 as 0 and one over 1 as 1, as CSS
 * clamps an sRGB colour, so a byte that wasn't divided by 255 is drawn as 1.
 * NaN or an infinity is not a colour, and fails the frame that draws it with an
 * error that names the entity.
 *
 * @category Spaces
 */
export const Srgb = 0 as const;

/**
 * The space of a renderer's own numbers, linear sRGB, in which the light of
 * two sources adds up. Its `r`, `g` and `b` are those that Three.js's
 * `new Color("#ff6188")` holds. A renderer takes each number as it is, and one
 * over 1 is brighter than white, which a renderer with bloom shows.
 *
 * **When to use**
 *
 * Use for a colour worked out as light, such as a glow that fades, or one
 * brighter than white. For a colour as a hex code writes it, use `Color.Srgb`.
 *
 * @category Spaces
 */
export const Linear = 1 as const;

/**
 * The space a colour's numbers are written in: `Color.Srgb` or `Color.Linear`.
 *
 * @category Spaces
 */
export type Space = typeof Srgb | typeof Linear;

const space: FieldDef<Space, Uint8Array> = { kind: "u8" };

/**
 * An entity's colour: an `r`, a `g` and a `b`, and the `space` they are
 * written in, `Color.Srgb` or `Color.Linear`. Added without a value, it is
 * white.
 *
 *   Color.Rgb.of({ r: 1, g: 0.5, b: 0, space: Color.Srgb })
 *   Color.Rgb.of({ r: 4, g: 2, b: 0, space: Color.Linear })
 *
 * **When to use**
 *
 * Use for the colour a renderer draws an entity in. A system that fades a
 * colour writes its numbers and keeps its space.
 *
 * @category Components
 */
export const Rgb = Component.define(
  "arcadekit/Color.Rgb",
  { r: Field.f32, g: Field.f32, b: Field.f32, space },
  { initial: { r: 1, g: 1, b: 1, space: Srgb } }
);

/**
 * Returns a colour written as a hex code, as `Color.Rgb.of` takes it: each
 * byte over 255, in `Color.Srgb`.
 *
 *   Color.Rgb.of(Color.hex(0xff6188))   // r 0xff / 255, g 0x61 / 255, b 0x88 / 255
 *
 * It throws for a number that is no hex code of a colour, a whole number from
 * `0x000000` to `0xffffff`.
 *
 * @category Constructors
 */
export const hex = (code: number): Parameters<typeof Rgb.of>[0] => {
  if (!Number.isInteger(code) || code < 0 || code > 0xff_ff_ff) {
    throw new Error(
      `Color.hex was given ${code}, which is not the hex code of a colour: a whole number from 0x000000 to 0xffffff, such as 0xff6188.`
    );
  }
  return {
    r: (code >> 16) / 255,
    g: ((code >> 8) & 255) / 255,
    b: (code & 255) / 255,
    space: Srgb,
  };
};

/** A numeric column, as `eachChunk` hands it. */
type Column = { readonly [row: number]: number };

/**
 * A frame's reads of the colour an entity is drawn in between its last two
 * ticks, as `Color.smooth` hands them: each number `Frame.alpha` of the way
 * from its value a tick ago to the value it has now, however far it changed.
 * The numbers are blended in the colour's own space.
 *
 * @category Models
 */
export interface Smooth {
  /** Returns the colour an entity is drawn in, given its `Rgb`, as a new object. */
  readonly color: (
    entity: Entity,
    color: { readonly r: number; readonly g: number; readonly b: number }
  ) => { r: number; g: number; b: number };
  /**
   * Blends the colours of a run of rows, as `eachChunk` hands them, into
   * columns of the app's own, which it returns. The next call overwrites them.
   */
  readonly colors: (
    start: number,
    end: number,
    color: { readonly r: Column; readonly g: Column; readonly b: Column },
    entities: EntityColumn
  ) => {
    readonly r: Float32Array;
    readonly g: Float32Array;
    readonly b: Float32Array;
  };
}

const row = new Row();

/**
 * The colours a frame system draws its entities in between their last two
 * ticks, from what the app keeps outside the world, as `Transform2d.smooth`
 * does for where they are. `@arcadekit/three` reads the same with `smooth`.
 *
 *   const smooth = yield* Color.smooth
 *   const { r, g, b } = smooth.color(entity, color)
 *
 * It requires `Frame`, so only a frame system can yield it.
 *
 * @category Services
 */
export const smooth: Effect.Effect<Smooth, never, Frame | Time> = smoothing(
  (store): Smooth => ({
    color: (entity, color) => {
      row.a[0] = color.r;
      row.b[0] = color.g;
      row.c[0] = color.b;
      const out = store.lerp3
        .of(Rgb)
        .blend(0, 1, row.a, row.b, row.c, row.of(entity));
      return { r: out.x[0]!, g: out.y[0]!, b: out.z[0]! };
    },
    colors: (start, end, color, entities) => {
      const out = store.lerp3
        .of(Rgb)
        .blend(start, end, color.r, color.g, color.b, entities);
      return { r: out.x, g: out.y, b: out.z };
    },
  })
);
