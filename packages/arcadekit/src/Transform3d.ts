/**
 * Position, rotation and scale in three dimensions. Everything that needs to
 * know where things are reads these components: the rules that move them, the
 * renderer that draws them, and the sound that plays from them. For a 2D game,
 * use `Transform2d`.
 *
 *   commands.spawn(
 *     Rock,
 *     Transform3d.Position.of({ x: 0, y: 4, z: 0 }),
 *     Transform3d.Rotation.of(Transform3d.axisAngle(0, 0, 1, Math.PI / 2))
 *   )
 *
 * They are ordinary components, columns of 32-bit floats that the game's
 * systems write, and that are saved, hashed and replayed. Nothing here draws. A
 * renderer reads them. `@arcadekit/three` draws an entity at its `Position`,
 * rotated and scaled by its `Rotation` and `Scale` if it has them.
 *
 * Give an entity only the components it needs. `Position` alone is enough for
 * something that only has a location. Add `Rotation` and `Scale` for things
 * that turn or have a size of their own. A save names each by module and
 * component, as the world does, such as `"arcadekit/Transform3d.Position"`.
 *
 * A frame system draws an entity between its last two ticks with
 * `Transform3d.smooth`, from what the app keeps outside the world. An entity
 * that the game teleports has `Transform3d.Teleports`, whose count the tick
 * adds one to, and every reader draws it where it landed.
 */
import { Component, Field } from "./ecs/component.ts";
import type { Entity } from "./ecs/component.ts";
import type { EntityColumn } from "./ecs/query.ts";
import { Row, smoothingPlaces } from "./internal/smooth.ts";

/**
 * An entity's position, in the game's units. Added without a value, it is at
 * the origin.
 *
 * @category Components
 */
export const Position = Component.define("arcadekit/Transform3d.Position", {
  x: Field.f32,
  y: Field.f32,
  z: Field.f32,
});

/**
 * An entity's rotation, as a quaternion. `Transform3d.axisAngle` makes one.
 *
 * Only the direction of the quaternion matters, not its length. A quaternion of
 * any length represents the same rotation as the unit quaternion in its
 * direction. Everything that reads a `Rotation` normalizes it, so one that
 * drifts from length 1 still draws as the same rotation. All four fields at 0,
 * which is a `Rotation` added without a value, means no rotation.
 *
 * @category Components
 */
export const Rotation = Component.define("arcadekit/Transform3d.Rotation", {
  x: Field.f32,
  y: Field.f32,
  z: Field.f32,
  w: Field.f32,
});

/**
 * An entity's size along each axis, where 1 is its original size. Added
 * without a value, it is 1 along each.
 *
 * @category Components
 */
export const Scale = Component.define(
  "arcadekit/Transform3d.Scale",
  { x: Field.f32, y: Field.f32, z: Field.f32 },
  { initial: { x: 1, y: 1, z: 1 } }
);

/**
 * How many times an entity has teleported, which the tick that teleports it
 * adds one to. Between two ticks, an entity is drawn on its way from where it
 * was to where it is. One whose `count` changed since the previous frame is
 * drawn where it is instead, at its `Position`, `Rotation` and `Scale`, by
 * every reader of `Transform3d.smooth` and by `@arcadekit/three`.
 *
 *   commands.spawn(Player, Transform3d.Position, Transform3d.Teleports)
 *
 *   ;(yield* Fallen).each((position, teleports) => {
 *     position.y = 10
 *     teleports.count += 1
 *   })
 *
 * **When to use**
 *
 * Use with an entity that the game moves, in one tick, from one place to
 * another it doesn't travel through: one that comes back to a checkpoint, or
 * wraps from one edge of the world to the other. Every reader then draws the
 * teleport alike, where a `snap` is a distance each reader gives of its own.
 *
 * **Details**
 *
 * - It is a component of the game, saved, hashed and replayed. A rewind takes
 *   back a teleport with the tick that made it, and a tick run again counts
 *   its own again, so a peer that hears of a teleport late draws the entity
 *   where it landed.
 * - What counts is that the count changed since the previous frame, not what
 *   it is. Added bare, it is 0: no teleport.
 *
 * @category Components
 */
export const Teleports = Component.define("arcadekit/Transform3d.Teleports", {
  count: Field.u32,
});

/**
 * Returns the `Rotation` that turns by `angle` radians about an axis.
 *
 *   Transform3d.axisAngle(0, 1, 0, Math.PI)   // half a turn about y
 *
 * The axis is a direction of any non-zero length, and a zero axis gives no
 * rotation. The result has length 1.
 *
 * **Gotchas**
 *
 * - It allocates an object, so use it for a spawn or a `world.set`, not in a
 *   loop over columns.
 *
 * @category Utilities
 */
export const axisAngle = (
  x: number,
  y: number,
  z: number,
  angle: number
): { x: number; y: number; z: number; w: number } => {
  const length = Math.hypot(x, y, z);
  if (length === 0) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  // Over the axis's length: the angle would be another for an axis that
  // is not of length 1, and not only the quaternion's length.
  const sin = Math.sin(angle / 2) / length;
  return { x: x * sin, y: y * sin, z: z * sin, w: Math.cos(angle / 2) };
};

/**
 * A frame's reads of where an entity is drawn between its last two ticks, as
 * `Transform3d.smooth` hands them. Each is `Frame.alpha` of the way from the
 * entity's value a tick ago to the value it is given, the entity's value now.
 *
 * An entity not read in the previous frame, by any frame system or by
 * `@arcadekit/three`, is drawn where it is. That includes a new entity, one in
 * a slot that belonged to another, and every entity in an app's first frame.
 * So is an entity whose `Teleports` count changed since the previous frame, at
 * its position, rotation and scale. Each call of `position`, `rotation` and
 * `scale` returns a new object.
 * `positions`, `rotations` and `scales` blend a run of rows that `eachChunk`
 * hands out, for a loop over columns, and allocate nothing per entity.
 *
 * @category Models
 */
export interface Smooth {
  /**
   * Returns where an entity is drawn, given its `Position`. One that moved
   * farther than `snap` in a tick is drawn at `position` too, for a move the
   * game doesn't count in `Teleports`. Without `snap`, any distance is motion.
   */
  readonly position: (
    entity: Entity,
    position: { readonly x: number; readonly y: number; readonly z: number },
    snap?: number
  ) => { x: number; y: number; z: number };
  /**
   * Returns the rotation an entity is drawn at, given its `Rotation`, turned
   * along the shorter arc. Like a `Rotation`, it is of any length, and only its
   * direction matters.
   */
  readonly rotation: (
    entity: Entity,
    rotation: {
      readonly x: number;
      readonly y: number;
      readonly z: number;
      readonly w: number;
    }
  ) => { x: number; y: number; z: number; w: number };
  /** Returns the size an entity is drawn at, given its `Scale`. */
  readonly scale: (
    entity: Entity,
    scale: { readonly x: number; readonly y: number; readonly z: number }
  ) => { x: number; y: number; z: number };
  /**
   * Blends the positions of a run of rows, as `eachChunk` hands them, into
   * columns of the app's own, which it returns: row `i` of the result is where
   * the entity of row `i` is drawn. The next call overwrites them.
   */
  readonly positions: (
    start: number,
    end: number,
    position: { readonly x: Column; readonly y: Column; readonly z: Column },
    entities: EntityColumn,
    snap?: number
  ) => {
    readonly x: Float32Array;
    readonly y: Float32Array;
    readonly z: Float32Array;
  };
  /** Blends the rotations of a run of rows, as `positions` does. */
  readonly rotations: (
    start: number,
    end: number,
    rotation: {
      readonly x: Column;
      readonly y: Column;
      readonly z: Column;
      readonly w: Column;
    },
    entities: EntityColumn
  ) => {
    readonly x: Float32Array;
    readonly y: Float32Array;
    readonly z: Float32Array;
    readonly w: Float32Array;
  };
  /** Blends the scales of a run of rows, as `positions` does. */
  readonly scales: (
    start: number,
    end: number,
    scale: { readonly x: Column; readonly y: Column; readonly z: Column },
    entities: EntityColumn
  ) => {
    readonly x: Float32Array;
    readonly y: Float32Array;
    readonly z: Float32Array;
  };
}

/** A numeric column, as `eachChunk` hands it. */
type Column = { readonly [row: number]: number };

const row = new Row();

/**
 * Where a frame system draws its entities between their last two ticks, from
 * what the app keeps of their positions, rotations and scales outside the
 * world.
 *
 *   const Follow = System.frame("game/Follow", function* () {
 *     const smooth = yield* Transform3d.smooth
 *     ;(yield* Players).each((position, _player, entity) => {
 *       const at = smooth.position(entity, position)
 *       camera.position.set(at.x, at.y + 10, at.z + 20)
 *     })
 *   })
 *
 * **When to use**
 *
 * Use to draw an entity in a frame system of your own, such as a camera that
 * follows it, as smoothly as `@arcadekit/three` draws a kind with
 * `smooth: true`. Both read the same store, so the camera stays on an entity
 * that `Three.instances` or `Three.objects` draws between ticks.
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
 * - Before the first reader of a frame blends, the app looks at every entity
 *   with `Teleports`, so every reader draws one that teleported where it
 *   landed. A `snap` is the reader's own, and two readers that give different
 *   distances draw a long move differently.
 *
 * @category Services
 */
export const smooth = smoothingPlaces(
  (store): Smooth => ({
    positions: (start, end, position, entities, snap) =>
      store.lerp3
        .of(Position)
        .blend(start, end, position.x, position.y, position.z, entities, snap),
    rotations: (start, end, rotation, entities) =>
      store.nlerp4
        .of(Rotation)
        .blend(
          start,
          end,
          rotation.x,
          rotation.y,
          rotation.z,
          rotation.w,
          entities
        ),
    scales: (start, end, scale, entities) =>
      store.lerp3
        .of(Scale)
        .blend(start, end, scale.x, scale.y, scale.z, entities),
    position: (entity, position, snap) => {
      row.a[0] = position.x;
      row.b[0] = position.y;
      row.c[0] = position.z;
      const out = store.lerp3
        .of(Position)
        .blend(0, 1, row.a, row.b, row.c, row.of(entity), snap);
      return { x: out.x[0]!, y: out.y[0]!, z: out.z[0]! };
    },
    rotation: (entity, rotation) => {
      row.a[0] = rotation.x;
      row.b[0] = rotation.y;
      row.c[0] = rotation.z;
      row.d[0] = rotation.w;
      const out = store.nlerp4
        .of(Rotation)
        .blend(0, 1, row.a, row.b, row.c, row.d, row.of(entity));
      return { x: out.x[0]!, y: out.y[0]!, z: out.z[0]!, w: out.w[0]! };
    },
    scale: (entity, scale) => {
      row.a[0] = scale.x;
      row.b[0] = scale.y;
      row.c[0] = scale.z;
      const out = store.lerp3
        .of(Scale)
        .blend(0, 1, row.a, row.b, row.c, row.of(entity));
      return { x: out.x[0]!, y: out.y[0]!, z: out.z[0]! };
    },
  }),
  Teleports,
  [Position, Rotation, Scale]
);
