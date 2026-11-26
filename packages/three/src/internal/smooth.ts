import { entityGeneration, entityIndex } from "arcadekit/ecs";
import type { EntityColumn } from "arcadekit/ecs";

import type { KindOptions } from "../Three.ts";
import type { Angle, Numbers, Xy, Xyz, Xyzw } from "./columns.ts";

// What a system keeps to draw its entities between their last two places:
// for each component it reads, the value an entity had a tick ago and the
// value it has, by the entity's index. It is the renderer's own, never the
// world's: a game that is drawn smoothly is the same game.

/** What one system's stores agree on, for the frame being drawn. */
interface Clock {
  /**
   * The app's frame number, counted from 2, since 0 in a store means never
   * seen. It is the app's count, not the system's, so the store knows the
   * entity was drawn in the previous frame, not merely the last time the system
   * ran.
   */
  stamp: number;
  /** Whether a tick ran since the previous frame, which makes the current values a tick old. */
  shift: boolean;
  /** How far the frame is between the last two ticks. */
  alpha: number;
}

/** One component's two values per entity, and the columns they are blended into. */
abstract class Blend {
  protected readonly clock: Clock;
  private readonly width: number;
  /** For each entity index, the generation of the entity these values belong to. */
  protected generations = new Uint32Array(0);
  /** For each entity index, the frame its entity was last drawn in. */
  protected seen = new Uint32Array(0);
  protected prev = new Float32Array(0);
  protected cur = new Float32Array(0);
  /** The number of rows the blended columns have room for. */
  protected rows = 0;

  constructor(clock: Clock, width: number) {
    this.clock = clock;
    this.width = width;
  }

  /** Makes room for these rows and their entities, before the loop reads either. */
  protected fit(start: number, end: number, entities: EntityColumn): void {
    let most = -1;
    for (let i = start; i < end; i++) {
      const index = entityIndex(entities[i]!);
      if (index > most) {
        most = index;
      }
    }
    if (most >= this.generations.length) {
      let length = Math.max(64, this.generations.length);
      while (length <= most) {
        length *= 2;
      }
      const generations = new Uint32Array(length);
      generations.set(this.generations);
      this.generations = generations;
      const seen = new Uint32Array(length);
      seen.set(this.seen);
      this.seen = seen;
      const prev = new Float32Array(length * this.width);
      prev.set(this.prev);
      this.prev = prev;
      const cur = new Float32Array(length * this.width);
      cur.set(this.cur);
      this.cur = cur;
    }
    if (end > this.rows) {
      this.rows = Math.max(end, this.rows * 2);
      this.widen(this.rows);
    }
  }

  /** Reallocates the blended columns with this many rows. */
  protected abstract widen(rows: number): void;
}

/** A 3D position or size: each number is interpolated linearly. */
class Lerp3 extends Blend {
  private readonly out = {
    x: new Float32Array(0),
    y: new Float32Array(0),
    z: new Float32Array(0),
  };
  /** The square of the distance that is too far to have moved in one tick. */
  private readonly snap: number;

  constructor(clock: Clock, snap = Infinity) {
    super(clock, 3);
    this.snap = snap * snap;
  }

  protected widen(rows: number): void {
    this.out.x = new Float32Array(rows);
    this.out.y = new Float32Array(rows);
    this.out.z = new Float32Array(rows);
  }

  blend(start: number, end: number, from: Xyz, entities: EntityColumn): Xyz {
    return this.run(start, end, from.x, from.y, from.z, entities);
  }

  /** Like `blend`, for any three columns, such as a colour's. */
  run(
    start: number,
    end: number,
    x: Numbers,
    y: Numbers,
    z: Numbers,
    entities: EntityColumn
  ): Xyz {
    this.fit(start, end, entities);
    const { cur, generations, out, prev, seen, snap } = this;
    const { alpha, shift, stamp } = this.clock;
    const { x: ox, y: oy, z: oz } = out;
    for (let i = start; i < end; i++) {
      const entity = entities[i]!;
      const index = entityIndex(entity);
      const generation = entityGeneration(entity);
      const at = index * 3;
      const a = x[i]!;
      const b = y[i]!;
      const c = z[i]!;
      let px = a;
      let py = b;
      let pz = c;
      // Drawn in the frame before this one: it has a place to come from.
      if (generations[index] === generation && seen[index] === stamp - 1) {
        px = shift ? cur[at]! : prev[at]!;
        py = shift ? cur[at + 1]! : prev[at + 1]!;
        pz = shift ? cur[at + 2]! : prev[at + 2]!;
        const dx = a - px;
        const dy = b - py;
        const dz = c - pz;
        if (dx * dx + dy * dy + dz * dz > snap) {
          px = a;
          py = b;
          pz = c;
        }
      }
      generations[index] = generation;
      seen[index] = stamp;
      prev[at] = px;
      prev[at + 1] = py;
      prev[at + 2] = pz;
      cur[at] = a;
      cur[at + 1] = b;
      cur[at + 2] = c;
      ox[i] = px + (a - px) * alpha;
      oy[i] = py + (b - py) * alpha;
      oz[i] = pz + (c - pz) * alpha;
    }
    return out;
  }
}

/** A 2D position or size. */
class Lerp2 extends Blend {
  private readonly out = { x: new Float32Array(0), y: new Float32Array(0) };
  private readonly snap: number;

  constructor(clock: Clock, snap = Infinity) {
    super(clock, 2);
    this.snap = snap * snap;
  }

  protected widen(rows: number): void {
    this.out.x = new Float32Array(rows);
    this.out.y = new Float32Array(rows);
  }

  blend(start: number, end: number, from: Xy, entities: EntityColumn): Xy {
    this.fit(start, end, entities);
    const { cur, generations, out, prev, seen, snap } = this;
    const { alpha, shift, stamp } = this.clock;
    const { x, y } = from;
    const { x: ox, y: oy } = out;
    for (let i = start; i < end; i++) {
      const entity = entities[i]!;
      const index = entityIndex(entity);
      const generation = entityGeneration(entity);
      const at = index * 2;
      const a = x[i]!;
      const b = y[i]!;
      let px = a;
      let py = b;
      if (generations[index] === generation && seen[index] === stamp - 1) {
        px = shift ? cur[at]! : prev[at]!;
        py = shift ? cur[at + 1]! : prev[at + 1]!;
        const dx = a - px;
        const dy = b - py;
        if (dx * dx + dy * dy > snap) {
          px = a;
          py = b;
        }
      }
      generations[index] = generation;
      seen[index] = stamp;
      prev[at] = px;
      prev[at + 1] = py;
      cur[at] = a;
      cur[at + 1] = b;
      ox[i] = px + (a - px) * alpha;
      oy[i] = py + (b - py) * alpha;
    }
    return out;
  }
}

/**
 * A 3D rotation: from one quaternion towards the other along the shorter arc.
 * The result isn't normalized, and doesn't need to be.
 */
class Nlerp4 extends Blend {
  private readonly out = {
    x: new Float32Array(0),
    y: new Float32Array(0),
    z: new Float32Array(0),
    w: new Float32Array(0),
  };

  constructor(clock: Clock) {
    super(clock, 4);
  }

  protected widen(rows: number): void {
    this.out.x = new Float32Array(rows);
    this.out.y = new Float32Array(rows);
    this.out.z = new Float32Array(rows);
    this.out.w = new Float32Array(rows);
  }

  blend(start: number, end: number, from: Xyzw, entities: EntityColumn): Xyzw {
    this.fit(start, end, entities);
    const { cur, generations, out, prev, seen } = this;
    const { alpha, shift, stamp } = this.clock;
    const { x, y, z, w } = from;
    const { x: ox, y: oy, z: oz, w: ow } = out;
    for (let i = start; i < end; i++) {
      const entity = entities[i]!;
      const index = entityIndex(entity);
      const generation = entityGeneration(entity);
      const at = index * 4;
      const a = x[i]!;
      const b = y[i]!;
      const c = z[i]!;
      const d = w[i]!;
      let px = a;
      let py = b;
      let pz = c;
      let pw = d;
      if (generations[index] === generation && seen[index] === stamp - 1) {
        px = shift ? cur[at]! : prev[at]!;
        py = shift ? cur[at + 1]! : prev[at + 1]!;
        pz = shift ? cur[at + 2]! : prev[at + 2]!;
        pw = shift ? cur[at + 3]! : prev[at + 3]!;
      }
      generations[index] = generation;
      seen[index] = stamp;
      prev[at] = px;
      prev[at + 1] = py;
      prev[at + 2] = pz;
      prev[at + 3] = pw;
      cur[at] = a;
      cur[at + 1] = b;
      cur[at + 2] = c;
      cur[at + 3] = d;
      // A quaternion and its opposite are one turn: towards whichever of
      // the two is nearer, or the blend would go the long way round.
      const near = px * a + py * b + pz * c + pw * d < 0 ? -1 : 1;
      const bx = px + (a * near - px) * alpha;
      const by = py + (b * near - py) * alpha;
      const bz = pz + (c * near - pz) * alpha;
      const bw = pw + (d * near - pw) * alpha;
      // Of whatever length it comes out: what draws it takes the turn a
      // quaternion stands for, and all zeros for not turned.
      ox[i] = bx;
      oy[i] = by;
      oz[i] = bz;
      ow[i] = bw;
    }
    return out;
  }
}

const TURN = Math.PI * 2;

/** A 2D rotation: from one angle to the other the shorter way round. */
class Arc extends Blend {
  private readonly out = { angle: new Float32Array(0) };

  constructor(clock: Clock) {
    super(clock, 1);
  }

  protected widen(rows: number): void {
    this.out.angle = new Float32Array(rows);
  }

  blend(
    start: number,
    end: number,
    from: Angle,
    entities: EntityColumn
  ): Angle {
    this.fit(start, end, entities);
    const { cur, generations, prev, seen } = this;
    const { alpha, shift, stamp } = this.clock;
    const { angle } = from;
    const out = this.out.angle;
    for (let i = start; i < end; i++) {
      const entity = entities[i]!;
      const index = entityIndex(entity);
      const generation = entityGeneration(entity);
      const a = angle[i]!;
      let before = a;
      if (generations[index] === generation && seen[index] === stamp - 1) {
        before = shift ? cur[index]! : prev[index]!;
      }
      generations[index] = generation;
      seen[index] = stamp;
      prev[index] = before;
      cur[index] = a;
      const turned = a - before;
      out[i] = before + (turned - TURN * Math.round(turned / TURN)) * alpha;
    }
    return this.out;
  }
}

/**
 * Everything one system keeps to interpolate its entities between two ticks.
 *
 * @internal
 */
export class Smooth {
  private readonly clock: Clock = { stamp: 0, shift: false, alpha: 0 };
  private tick = -1;
  readonly position: Lerp3;
  readonly rotation: Nlerp4;
  readonly scale: Lerp3;
  readonly flatPosition: Lerp2;
  readonly flatRotation: Arc;
  readonly flatScale: Lerp2;
  readonly color: Lerp3;

  constructor(snap: number | undefined) {
    this.position = new Lerp3(this.clock, snap);
    this.rotation = new Nlerp4(this.clock);
    this.scale = new Lerp3(this.clock);
    this.flatPosition = new Lerp2(this.clock, snap);
    this.flatRotation = new Arc(this.clock);
    this.flatScale = new Lerp2(this.clock);
    this.color = new Lerp3(this.clock);
  }

  /** Starts a frame: its number, the game's tick, and how far it is towards the next. */
  begin(tick: number, alpha: number, frame: number): void {
    this.clock.stamp = frame + 1;
    this.clock.shift = tick !== this.tick;
    this.clock.alpha = Math.min(1, Math.max(0, alpha));
    this.tick = tick;
  }
}

/**
 * What interpolates a kind's entities, when it is drawn smoothly.
 *
 * @internal
 */
export const smoothOf = (which: KindOptions): Smooth | undefined =>
  which.smooth === true ? new Smooth(which.snap) : undefined;
