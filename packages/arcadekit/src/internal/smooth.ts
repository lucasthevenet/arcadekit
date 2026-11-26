/**
 * What an app keeps to draw its entities between their last two ticks: for
 * each component read smoothly, the value an entity had a tick ago and the
 * value it has, by the entity's index. It is the frame stage's, never the
 * world's: a game that is drawn smoothly is the same game. `Transform2d.smooth`
 * and `Transform3d.smooth` read it, and so does what `@arcadekit/three` draws,
 * so that a camera of the game's own and an instance agree on where an entity
 * is drawn.
 *
 * Nothing records a value until a frame reads it, so a game that draws nothing
 * smoothly pays nothing. An entity read in one frame is read from where it was
 * in the next: whoever reads it first in a frame brings its two values up to
 * that frame, and every other reader of the frame blends the same two.
 */
import { Context, Effect } from "effect";

import { entityGeneration, entityIndex } from "../ecs/component.ts";
import type { Entity } from "../ecs/component.ts";
import type { EntityColumn } from "../ecs/query.ts";
import { Frame, Time } from "../Services.ts";
import type { FrameState } from "../Services.ts";

/**
 * A numeric column, as a loop reads it.
 *
 * @internal
 */
export interface Numbers {
  readonly [row: number]: number;
}

/** What one app's blends agree on, for the frame being drawn. */
interface Clock {
  /**
   * The app's frame number, counted from 2, since 0 in a store means never
   * seen, so a blend knows the entity was read in the frame before this one.
   */
  stamp: number;
  /** Whether a tick ran since the previous frame, which makes the current values a tick old. */
  shift: boolean;
  /** How far the frame is between the last two ticks. */
  alpha: number;
}

// What becomes of an entity's previous value when a frame reads it, which
// each loop works out in its own body, calling nothing per row.
/** An entity with no history: both its values become the one it has now. */
const FRESH = 0;
/** A tick ran since it was last read: its current value becomes its previous one. */
const SHIFT = 1;
/** It keeps its previous value, and takes the one it has now as its current. */
const KEEP = 2;

/** One component's two values per entity, and the columns they are blended into. */
abstract class Blend {
  protected readonly clock: Clock;
  private readonly width: number;
  /** For each entity index, the generation of the entity these values belong to. */
  protected generations = new Uint32Array(0);
  /** For each entity index, the frame its entity was last read in. */
  protected seen = new Uint32Array(0);
  protected prev = new Float32Array(0);
  protected cur = new Float32Array(0);
  /** The number of rows the blended columns have room for. */
  private rows = 0;

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

/**
 * A 3D position, size or colour: each number is interpolated linearly.
 *
 * @internal
 */
export class Lerp3 extends Blend {
  private readonly out = {
    x: new Float32Array(0),
    y: new Float32Array(0),
    z: new Float32Array(0),
  };

  constructor(clock: Clock) {
    super(clock, 3);
  }

  protected widen(rows: number): void {
    this.out.x = new Float32Array(rows);
    this.out.y = new Float32Array(rows);
    this.out.z = new Float32Array(rows);
  }

  /**
   * Blends these rows into columns of its own, which it returns. A row that
   * moved farther than `snap` since a tick ago is its value as it is.
   */
  blend(
    start: number,
    end: number,
    x: Numbers,
    y: Numbers,
    z: Numbers,
    entities: EntityColumn,
    snap = Infinity
  ): {
    readonly x: Float32Array;
    readonly y: Float32Array;
    readonly z: Float32Array;
  } {
    this.fit(start, end, entities);
    const { cur, generations, out, prev, seen } = this;
    const { alpha, shift, stamp } = this.clock;
    const far = snap * snap;
    const { x: ox, y: oy, z: oz } = out;
    for (let i = start; i < end; i++) {
      const entity = entities[i]!;
      const index = entityIndex(entity);
      const at = index * 3;
      const generation = entityGeneration(entity);
      let what = FRESH;
      if (generations[index] === generation) {
        const last = seen[index]!;
        // Read already in this frame, by a reader before this one.
        if (last === stamp) {
          what = KEEP;
        } else if (last === stamp - 1) {
          what = shift ? SHIFT : KEEP;
        }
      }
      generations[index] = generation;
      seen[index] = stamp;
      if (what === SHIFT) {
        prev[at] = cur[at]!;
        prev[at + 1] = cur[at + 1]!;
        prev[at + 2] = cur[at + 2]!;
      }
      const a = x[i]!;
      const b = y[i]!;
      const c = z[i]!;
      cur[at] = a;
      cur[at + 1] = b;
      cur[at + 2] = c;
      if (what === FRESH) {
        prev[at] = a;
        prev[at + 1] = b;
        prev[at + 2] = c;
      }
      let px = prev[at]!;
      let py = prev[at + 1]!;
      let pz = prev[at + 2]!;
      const dx = a - px;
      const dy = b - py;
      const dz = c - pz;
      if (dx * dx + dy * dy + dz * dz > far) {
        px = a;
        py = b;
        pz = c;
      }
      ox[i] = px + (a - px) * alpha;
      oy[i] = py + (b - py) * alpha;
      oz[i] = pz + (c - pz) * alpha;
    }
    return out;
  }
}

/**
 * A 2D position or size.
 *
 * @internal
 */
export class Lerp2 extends Blend {
  private readonly out = { x: new Float32Array(0), y: new Float32Array(0) };

  constructor(clock: Clock) {
    super(clock, 2);
  }

  protected widen(rows: number): void {
    this.out.x = new Float32Array(rows);
    this.out.y = new Float32Array(rows);
  }

  /** As `Lerp3.blend`, for two numbers. */
  blend(
    start: number,
    end: number,
    x: Numbers,
    y: Numbers,
    entities: EntityColumn,
    snap = Infinity
  ): { readonly x: Float32Array; readonly y: Float32Array } {
    this.fit(start, end, entities);
    const { cur, generations, out, prev, seen } = this;
    const { alpha, shift, stamp } = this.clock;
    const far = snap * snap;
    const { x: ox, y: oy } = out;
    for (let i = start; i < end; i++) {
      const entity = entities[i]!;
      const index = entityIndex(entity);
      const at = index * 2;
      const generation = entityGeneration(entity);
      let what = FRESH;
      if (generations[index] === generation) {
        const last = seen[index]!;
        // Read already in this frame, by a reader before this one.
        if (last === stamp) {
          what = KEEP;
        } else if (last === stamp - 1) {
          what = shift ? SHIFT : KEEP;
        }
      }
      generations[index] = generation;
      seen[index] = stamp;
      if (what === SHIFT) {
        prev[at] = cur[at]!;
        prev[at + 1] = cur[at + 1]!;
      }
      const a = x[i]!;
      const b = y[i]!;
      cur[at] = a;
      cur[at + 1] = b;
      if (what === FRESH) {
        prev[at] = a;
        prev[at + 1] = b;
      }
      let px = prev[at]!;
      let py = prev[at + 1]!;
      const dx = a - px;
      const dy = b - py;
      if (dx * dx + dy * dy > far) {
        px = a;
        py = b;
      }
      ox[i] = px + (a - px) * alpha;
      oy[i] = py + (b - py) * alpha;
    }
    return out;
  }
}

/**
 * A 3D rotation: from one quaternion towards the other along the shorter arc.
 * The result isn't normalized, and doesn't need to be.
 *
 * @internal
 */
export class Nlerp4 extends Blend {
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

  /** Blends these rows into columns of its own, which it returns. */
  blend(
    start: number,
    end: number,
    x: Numbers,
    y: Numbers,
    z: Numbers,
    w: Numbers,
    entities: EntityColumn
  ): {
    readonly x: Float32Array;
    readonly y: Float32Array;
    readonly z: Float32Array;
    readonly w: Float32Array;
  } {
    this.fit(start, end, entities);
    const { cur, generations, out, prev, seen } = this;
    const { alpha, shift, stamp } = this.clock;
    const { x: ox, y: oy, z: oz, w: ow } = out;
    for (let i = start; i < end; i++) {
      const entity = entities[i]!;
      const index = entityIndex(entity);
      const at = index * 4;
      const generation = entityGeneration(entity);
      let what = FRESH;
      if (generations[index] === generation) {
        const last = seen[index]!;
        // Read already in this frame, by a reader before this one.
        if (last === stamp) {
          what = KEEP;
        } else if (last === stamp - 1) {
          what = shift ? SHIFT : KEEP;
        }
      }
      generations[index] = generation;
      seen[index] = stamp;
      if (what === SHIFT) {
        prev[at] = cur[at]!;
        prev[at + 1] = cur[at + 1]!;
        prev[at + 2] = cur[at + 2]!;
        prev[at + 3] = cur[at + 3]!;
      }
      const a = x[i]!;
      const b = y[i]!;
      const c = z[i]!;
      const d = w[i]!;
      cur[at] = a;
      cur[at + 1] = b;
      cur[at + 2] = c;
      cur[at + 3] = d;
      if (what === FRESH) {
        prev[at] = a;
        prev[at + 1] = b;
        prev[at + 2] = c;
        prev[at + 3] = d;
      }
      const px = prev[at]!;
      const py = prev[at + 1]!;
      const pz = prev[at + 2]!;
      const pw = prev[at + 3]!;
      // A quaternion and its opposite are one turn: towards whichever of
      // the two is nearer, or the blend would go the long way round.
      const near = px * a + py * b + pz * c + pw * d < 0 ? -1 : 1;
      ox[i] = px + (a * near - px) * alpha;
      oy[i] = py + (b * near - py) * alpha;
      oz[i] = pz + (c * near - pz) * alpha;
      ow[i] = pw + (d * near - pw) * alpha;
    }
    return out;
  }
}

const TURN = Math.PI * 2;

/**
 * A 2D rotation: from one angle to the other the shorter way round.
 *
 * @internal
 */
export class Arc extends Blend {
  private readonly out = { angle: new Float32Array(0) };

  constructor(clock: Clock) {
    super(clock, 1);
  }

  protected widen(rows: number): void {
    this.out.angle = new Float32Array(rows);
  }

  /** Blends these rows into a column of its own, which it returns. */
  blend(
    start: number,
    end: number,
    angle: Numbers,
    entities: EntityColumn
  ): { readonly angle: Float32Array } {
    this.fit(start, end, entities);
    const { cur, generations, prev, seen } = this;
    const { alpha, shift, stamp } = this.clock;
    const out = this.out.angle;
    for (let i = start; i < end; i++) {
      const entity = entities[i]!;
      const index = entityIndex(entity);
      const generation = entityGeneration(entity);
      let what = FRESH;
      if (generations[index] === generation) {
        const last = seen[index]!;
        // Read already in this frame, by a reader before this one.
        if (last === stamp) {
          what = KEEP;
        } else if (last === stamp - 1) {
          what = shift ? SHIFT : KEEP;
        }
      }
      generations[index] = generation;
      seen[index] = stamp;
      if (what === SHIFT) {
        prev[index] = cur[index]!;
      }
      const a = angle[i]!;
      cur[index] = a;
      if (what === FRESH) {
        prev[index] = a;
      }
      const before = prev[index]!;
      const turned = a - before;
      out[i] = before + (turned - TURN * Math.round(turned / TURN)) * alpha;
    }
    return this.out;
  }
}

/** A blend of one kind for each component, made when a frame first asks. */
class Blends<B> {
  private readonly made = new Map<object, B>();

  constructor(private readonly make: () => B) {}

  of(component: object): B {
    let blend = this.made.get(component);
    if (blend === undefined) {
      blend = this.make();
      this.made.set(component, blend);
    }
    return blend;
  }
}

/**
 * Everything one app keeps to draw its entities between two ticks, by
 * component.
 *
 * @internal
 */
export class Smoothing {
  private readonly clock: Clock = { stamp: 0, shift: false, alpha: 0 };
  private tick = -1;
  private count = -1;
  readonly lerp2 = new Blends(() => new Lerp2(this.clock));
  readonly lerp3 = new Blends(() => new Lerp3(this.clock));
  readonly nlerp4 = new Blends(() => new Nlerp4(this.clock));
  readonly arc = new Blends(() => new Arc(this.clock));

  /**
   * Starts a frame: its number, the game's tick, and how far it is towards
   * the next. A second call in the same frame changes nothing.
   */
  begin(tick: number, alpha: number, count: number): void {
    if (count === this.count) {
      return;
    }
    this.count = count;
    this.clock.stamp = count + 1;
    this.clock.shift = tick !== this.tick;
    this.clock.alpha = Math.min(1, Math.max(0, alpha));
    this.tick = tick;
  }
}

/** Each app's, by the frame it draws, which is its own object. */
const kept = new WeakMap<FrameState, Smoothing>();

/**
 * Returns the app's store of what is drawn between two ticks, started for the
 * frame being drawn, as `view` shows it to a reader. A view is made once per
 * app.
 *
 * @internal
 */
export const smoothing = <V>(
  view: (store: Smoothing) => V
): Effect.Effect<V, never, Frame | Time> => {
  const views = new WeakMap<Smoothing, V>();
  return Effect.map(Effect.context<Frame | Time>(), (context) => {
    const frame = Context.get(context, Frame);
    let store = kept.get(frame);
    if (store === undefined) {
      store = new Smoothing();
      kept.set(frame, store);
    }
    store.begin(Context.get(context, Time).tick, frame.alpha, frame.count);
    let seen = views.get(store);
    if (seen === undefined) {
      seen = view(store);
      views.set(store, seen);
    }
    return seen;
  });
};

/**
 * One row, for a read of one entity: a column of one number each, and an
 * entity column of one entity.
 *
 * @internal
 */
export class Row {
  readonly a = new Float32Array(1);
  readonly b = new Float32Array(1);
  readonly c = new Float32Array(1);
  readonly d = new Float32Array(1);
  private readonly entity: Entity[] = [];

  /** The entity column, holding this entity. */
  of(entity: Entity): EntityColumn {
    this.entity[0] = entity;
    return this.entity;
  }
}
