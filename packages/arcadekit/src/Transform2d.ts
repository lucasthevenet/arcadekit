/**
 * Position, rotation and scale for a 2D game. These are the same three
 * components as `Transform3d`, for a game that has no use for a third
 * dimension.
 *
 *   commands.spawn(
 *     Card,
 *     Transform2d.Position.of({ x: 120, y: 80 }),
 *     Transform2d.Rotation.of({ angle: Math.PI / 6 })
 *   )
 *
 * They are ordinary components, columns of 32-bit floats that the game's
 * systems write, and that are saved, hashed and replayed. Nothing here draws. A
 * renderer reads them. `@arcadekit/three` draws the entity in the x-y plane,
 * rotated about the axis perpendicular to it.
 *
 * Use one module or the other for an entity, not both. They are distinct
 * components with distinct names, and nothing keeps them in sync. A system
 * that queries `Transform3d.Position` doesn't find an entity that only has
 * `Transform2d.Position`. A save names each by module and component, as the
 * world does, such as `"arcadekit/Transform2d.Position"`.
 *
 * A frame system draws an entity between its last two ticks with
 * `Transform2d.smooth`, from what the app keeps outside the world.
 */
import type { Effect } from "effect";

import { Component, Field } from "./ecs/component.ts";
import type { Entity } from "./ecs/component.ts";
import type { EntityColumn } from "./ecs/query.ts";
import { Row, smoothing } from "./internal/smooth.ts";
import type { Frame, Time } from "./Services.ts";

/**
 * An entity's position, in the game's units. Added without a value, it is at
 * the origin.
 *
 * @category Components
 */
export const Position = Component.define("arcadekit/Transform2d.Position", {
  x: Field.f32,
  y: Field.f32,
});

/**
 * An entity's rotation, in radians. A positive angle turns from the x axis
 * towards the y axis, which is anticlockwise when y points up and clockwise
 * when it points down.
 *
 * @category Components
 */
export const Rotation = Component.define("arcadekit/Transform2d.Rotation", {
  angle: Field.f32,
});

/**
 * An entity's size along each axis, where 1 is its original size. Added
 * without a value, it is 1 along each.
 *
 * @category Components
 */
export const Scale = Component.define(
  "arcadekit/Transform2d.Scale",
  { x: Field.f32, y: Field.f32 },
  { initial: { x: 1, y: 1 } }
);

/**
 * A frame's reads of where an entity is drawn between its last two ticks, as
 * `Transform2d.smooth` hands them. Each is `Frame.alpha` of the way from the
 * entity's value a tick ago to the value it is given, the entity's value now.
 *
 * An entity not read in the previous frame, by any frame system or by
 * `@arcadekit/three`, is drawn where it is. That includes a new entity, one in
 * a slot that belonged to another, and every entity in an app's first frame.
 * Each call of `position`, `rotation` and `scale` returns a new object.
 * `positions`, `rotations` and `scales` blend a run of rows that `eachChunk`
 * hands out, for a loop over columns, and allocate nothing per entity.
 *
 * @category Models
 */
export interface Smooth {
  /**
   * Returns where an entity is drawn, given its `Position`. One that moved
   * farther than `snap` in a tick, such as one that was teleported, is drawn
   * at `position`. Without `snap`, any distance is motion.
   */
  readonly position: (
    entity: Entity,
    position: { readonly x: number; readonly y: number },
    snap?: number
  ) => { x: number; y: number };
  /** Returns the angle an entity is drawn at, given its `Rotation`, turned the shorter way round. */
  readonly rotation: (
    entity: Entity,
    rotation: { readonly angle: number }
  ) => number;
  /** Returns the size an entity is drawn at, given its `Scale`. */
  readonly scale: (
    entity: Entity,
    scale: { readonly x: number; readonly y: number }
  ) => { x: number; y: number };
  /**
   * Blends the positions of a run of rows, as `eachChunk` hands them, into
   * columns of the app's own, which it returns: row `i` of the result is where
   * the entity of row `i` is drawn. The next call overwrites them.
   */
  readonly positions: (
    start: number,
    end: number,
    position: { readonly x: Column; readonly y: Column },
    entities: EntityColumn,
    snap?: number
  ) => { readonly x: Float32Array; readonly y: Float32Array };
  /** Blends the rotations of a run of rows, as `positions` does. */
  readonly rotations: (
    start: number,
    end: number,
    rotation: { readonly angle: Column },
    entities: EntityColumn
  ) => { readonly angle: Float32Array };
  /** Blends the scales of a run of rows, as `positions` does. */
  readonly scales: (
    start: number,
    end: number,
    scale: { readonly x: Column; readonly y: Column },
    entities: EntityColumn
  ) => { readonly x: Float32Array; readonly y: Float32Array };
}

/** A numeric column, as `eachChunk` hands it. */
type Column = { readonly [row: number]: number };

const row = new Row();

/**
 * Where a frame system draws its entities between their last two ticks, from
 * what the app keeps of their positions, rotations and scales outside the
 * world.
 *
 *   const Draw = System.frame("game/Draw", function* () {
 *     const smooth = yield* Transform2d.smooth
 *     ;(yield* Sprites).each((position, _sprite, entity) => {
 *       const at = smooth.position(entity, position, 64)
 *       context.fillRect(at.x, at.y, 8, 8)
 *     })
 *   })
 *
 * **When to use**
 *
 * Use to draw a game of your own, on a canvas or in a camera that follows an
 * entity, as smoothly as `@arcadekit/three` draws a kind with `smooth: true`.
 * Both read the same store, so a camera that follows an entity drawn by
 * `Three.instances` stays on it between ticks.
 *
 * **Details**
 *
 * - It requires `Frame`, so only a frame system can yield it.
 * - The app records an entity's value when a frame first reads it, and nothing
 *   before: a game that reads nothing smoothly keeps nothing. What it keeps is
 *   not in the world, so the game's hash, log and save are the same with it or
 *   without.
 * - At an `alpha` of 0, just after a tick, an entity is drawn where it was
 *   before that tick. `app.frame()` draws at an `alpha` of 1, where the last
 *   tick left it, and so does a game that ticks only when needed, while it
 *   rests.
 * - When several ticks ran since the last frame, an entity moves from where it
 *   was in that frame. When none ran, it stays between the same two values.
 *
 * @category Services
 */
export const smooth: Effect.Effect<Smooth, never, Frame | Time> = smoothing(
  (store): Smooth => ({
    positions: (start, end, position, entities, snap) =>
      store.lerp2
        .of(Position)
        .blend(start, end, position.x, position.y, entities, snap),
    rotations: (start, end, rotation, entities) =>
      store.arc.of(Rotation).blend(start, end, rotation.angle, entities),
    scales: (start, end, scale, entities) =>
      store.lerp2.of(Scale).blend(start, end, scale.x, scale.y, entities),
    position: (entity, position, snap) => {
      row.a[0] = position.x;
      row.b[0] = position.y;
      const out = store.lerp2
        .of(Position)
        .blend(0, 1, row.a, row.b, row.of(entity), snap);
      return { x: out.x[0]!, y: out.y[0]! };
    },
    rotation: (entity, rotation) => {
      row.a[0] = rotation.angle;
      return store.arc.of(Rotation).blend(0, 1, row.a, row.of(entity))
        .angle[0]!;
    },
    scale: (entity, scale) => {
      row.a[0] = scale.x;
      row.b[0] = scale.y;
      const out = store.lerp2
        .of(Scale)
        .blend(0, 1, row.a, row.b, row.of(entity));
      return { x: out.x[0]!, y: out.y[0]! };
    },
  })
);
