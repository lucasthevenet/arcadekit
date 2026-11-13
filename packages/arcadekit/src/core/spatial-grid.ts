/**
 * Spatial grids: a uniform grid of cells for "which points are near here?", rebuilt from scratch
 * each step.
 *
 * A grid indexes the points of a pool by the cell each is in, with linked lists in flat typed
 * arrays, so building it and asking it allocate nothing. Its answers that test a distance do it
 * with exact arithmetic (`ExactMath.hypot2`), so every lockstep peer finds the same points
 * (ADR-0011). Not a tile map, which describes a level's static cells.
 *
 * @since 0.7.0
 */
import type { Types } from "effect";
import { Inspectable, Pipeable, Predicate } from "effect";
import { dual } from "effect/Function";

import { hypot2 } from "./exact-math";

const TypeId = "~arcadekit/core/SpatialGrid";

/**
 * A uniform 2D grid that finds the points near a place, over a square of the ground.
 *
 * **When to use**
 *
 * In a step over many moving things, to ask which are near one place: the enemies a shot can
 * hit, the neighbours an enemy keeps apart from, the nearest target. Build it once its points
 * have moved, then ask it.
 *
 * **Details**
 *
 * The axes are called x and y; a 3D game on a ground plane passes z as y. `within` and
 * `nearest` answer with the distance tested, and `query` gives the candidates of the cells a
 * circle overlaps, for a step that tests each pair itself. The grid keeps the arrays its last
 * build was given and reads them when asked; it never writes them.
 *
 * **Example** (Finding what is near)
 *
 * ```ts
 * import { SpatialGrid } from "arcadekit/core";
 *
 * const grid = SpatialGrid.make({ halfSize: 10, cellSize: 2, capacity: 3 });
 * const xs = new Float32Array([0, 0.5, 9]);
 * const ys = new Float32Array([0, 0.5, 9]);
 * SpatialGrid.build(grid, xs, ys, 3);
 *
 * const out = new Int32Array(8);
 * const found = SpatialGrid.within(grid, 0, 0, 1, out);
 * [...out.subarray(0, found)]; // => [1, 0]
 * SpatialGrid.nearest(grid, 8, 8, 5); // => 2
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface SpatialGrid
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** The number of cells on each axis. */
  readonly cols: number;
}

/**
 * What a spatial grid is made for: the square it covers, the size of its cells, and the most
 * points a build indexes.
 *
 * **When to use**
 *
 * To make a grid with `make`, sized for the arena and the pool it indexes.
 *
 * **Details**
 *
 * The grid covers `[-halfSize, halfSize]` on both axes, and a point outside is put in the edge
 * cell nearest it. A `cellSize` about the size of the largest radius asked for works well.
 * `capacity` is the capacity of the pool whose points it indexes.
 *
 * **Example** (Sizing a grid for an arena)
 *
 * ```ts
 * import { SpatialGrid } from "arcadekit/core";
 *
 * const options: SpatialGrid.Options = {
 *   halfSize: 40,
 *   cellSize: 4,
 *   capacity: 300,
 * };
 * SpatialGrid.make(options).cols; // => 20
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Options {
  /** The grid covers `[-halfSize, halfSize]` on both axes. Points outside are put in the edge cells. */
  readonly halfSize: number;
  /** About the size of the largest radius asked for works well. */
  readonly cellSize: number;
  /** The most points a build indexes: the capacity of the pool it indexes. */
  readonly capacity: number;
}

const NO_POINTS: ArrayLike<number> = [];

/** What the module's functions keep, which no caller reads. */
type Internal = Types.Mutable<SpatialGrid> & {
  halfSize: number;
  cellSize: number;
  /** The first point of each cell's list, or -1 for none. */
  head: Int32Array;
  /** The point after each point in its cell's list, or -1 at the end. */
  nextInCell: Int32Array;
  // What the last build was given. The grid reads them when asked, and never writes them.
  xs: ArrayLike<number>;
  ys: ArrayLike<number>;
  radii: ArrayLike<number> | undefined;
  /** How many points the last build indexed. */
  count: number;
  /** The widest radius of the last build, or 0 for one without radii. */
  widest: number;
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Internal) {
    return {
      _id: "SpatialGrid",
      cols: this.cols,
      cellSize: this.cellSize,
      capacity: this.nextInCell.length,
      count: this.count,
    };
  },
};

const cellCoord = (grid: Internal, v: number): number => {
  const c = Math.floor((v + grid.halfSize) / grid.cellSize);
  return Math.min(Math.max(c, 0), grid.cols - 1);
};

/**
 * Checks whether a value is a spatial grid.
 *
 * **When to use**
 *
 * Narrow an unknown value before building or asking it.
 *
 * **Example** (Recognising a grid)
 *
 * ```ts
 * import { SpatialGrid } from "arcadekit/core";
 *
 * const grid = SpatialGrid.make({ halfSize: 10, cellSize: 2, capacity: 8 });
 * SpatialGrid.isSpatialGrid(grid); // => true
 * SpatialGrid.isSpatialGrid({ cols: 10 }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isSpatialGrid = (value: unknown): value is SpatialGrid =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a grid with no points.
 *
 * **When to use**
 *
 * Once per run's state, beside the pool whose points it indexes.
 *
 * **Details**
 *
 * It has `ceil(2 * halfSize / cellSize)` cells on each axis. Its arrays are made here and never
 * again: building and asking it allocate nothing.
 *
 * **Example** (Making a grid)
 *
 * ```ts
 * import { SpatialGrid } from "arcadekit/core";
 *
 * const grid = SpatialGrid.make({ halfSize: 10, cellSize: 2, capacity: 8 });
 * grid.cols; // => 10
 * SpatialGrid.nearest(grid, 0, 0, 100); // => -1
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (options: Options): SpatialGrid => {
  const self = Object.create(Proto) as Internal;
  self.halfSize = options.halfSize;
  self.cellSize = options.cellSize;
  self.cols = Math.ceil((options.halfSize * 2) / options.cellSize);
  // -1 ends a cell's list, so a grid that was never built has no points.
  self.head = new Int32Array(self.cols * self.cols).fill(-1);
  self.nextInCell = new Int32Array(options.capacity);
  self.xs = NO_POINTS;
  self.ys = NO_POINTS;
  self.radii = undefined;
  self.count = 0;
  self.widest = 0;
  return self;
};

/** Whether a dual function of the grid was called with the grid first. */
const gridFirst = (args: IArguments): boolean => isSpatialGrid(args[0]);

/**
 * Indexes the first `count` points. Point i is `(xs[i], ys[i])`, and a circle of radius
 * `radii[i]` if `radii` is given.
 *
 * **When to use**
 *
 * Once per step, after the points have moved and their radii are set, before the step asks the
 * grid anything.
 *
 * **Details**
 *
 * The grid keeps the arrays and reads them when asked, so a pool's fields are passed as they
 * are. It throws a `RangeError` for more points than the grid's capacity, and for fewer radii
 * than points, before it changes anything: the build it had stands.
 *
 * **Example** (Building from a pool's fields)
 *
 * ```ts
 * import { EntityPool, SpatialGrid } from "arcadekit/core";
 *
 * const enemies = EntityPool.make(8, {
 *   x: Float32Array,
 *   z: Float32Array,
 *   radius: Float32Array,
 * });
 * const i = EntityPool.add(enemies);
 * enemies.fields.x[i] = 3;
 * enemies.fields.radius[i] = 2.5;
 *
 * const grid = SpatialGrid.make({ halfSize: 10, cellSize: 2, capacity: 8 });
 * const { x, z, radius } = enemies.fields;
 * SpatialGrid.build(grid, x, z, enemies.count, radius);
 * // A wide enemy overlaps a circle whose cell its centre is not in.
 * SpatialGrid.within(grid, 0, 0, 1, new Int32Array(4)); // => 1
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const build: {
  (
    xs: ArrayLike<number>,
    ys: ArrayLike<number>,
    count: number,
    radii?: ArrayLike<number>
  ): (self: SpatialGrid) => void;
  (
    self: SpatialGrid,
    xs: ArrayLike<number>,
    ys: ArrayLike<number>,
    count: number,
    radii?: ArrayLike<number>
  ): void;
} = dual(
  gridFirst,
  (
    self: SpatialGrid,
    xs: ArrayLike<number>,
    ys: ArrayLike<number>,
    count: number,
    radii?: ArrayLike<number>
  ): void => {
    const grid = self as Internal;
    // A point past the capacity has no place in the cells' lists, so a walk of one never ends.
    if (count > grid.nextInCell.length) {
      throw new RangeError(
        `SpatialGrid.build needs a count within the grid's capacity of ${grid.nextInCell.length}, got ${count}`
      );
    }
    // And a point with no radius overlaps nothing: `within` would leave it out in silence.
    if (radii !== undefined && radii.length < count) {
      throw new RangeError(
        `SpatialGrid.build needs a radius for each of its ${count} points, got ${radii.length}`
      );
    }
    grid.head.fill(-1);
    grid.xs = xs;
    grid.ys = ys;
    grid.radii = radii;
    grid.count = count;
    let widest = 0;
    for (let i = 0; i < count; i++) {
      const cell =
        cellCoord(grid, ys[i]!) * grid.cols + cellCoord(grid, xs[i]!);
      grid.nextInCell[i] = grid.head[cell]!;
      grid.head[cell] = i;
      if (radii !== undefined && radii[i]! > widest) {
        widest = radii[i]!;
      }
    }
    grid.widest = widest;
  }
);

/**
 * Writes into `out` the index of every point whose cell overlaps the circle of `radius` at
 * `(x, y)`, and returns how many.
 *
 * **When to use**
 *
 * For a step that tests each pair itself, such as a push between neighbours that reads the
 * offset it measures.
 *
 * **Details**
 *
 * These are candidates: no distance is tested and no radius counted, so some may be outside the
 * circle; `within` gives the points that overlap it. It walks the cells by rows, then columns,
 * then each cell's list, and stops when `out` is full.
 *
 * **Example** (Taking the candidates near the origin)
 *
 * ```ts
 * import { SpatialGrid } from "arcadekit/core";
 *
 * const grid = SpatialGrid.make({ halfSize: 10, cellSize: 2, capacity: 8 });
 * // Both are in the cell the circle is in. The second is 2.7 from the centre.
 * SpatialGrid.build(grid, [0.5, 1.9], [0.5, 1.9], 2);
 * const out = new Int32Array(8);
 * SpatialGrid.query(grid, 0, 0, 1, out); // => 2
 * SpatialGrid.within(grid, 0, 0, 1, out); // => 1
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const query: {
  (
    x: number,
    y: number,
    radius: number,
    out: Int32Array
  ): (self: SpatialGrid) => number;
  (
    self: SpatialGrid,
    x: number,
    y: number,
    radius: number,
    out: Int32Array
  ): number;
} = dual(
  5,
  (
    self: SpatialGrid,
    x: number,
    y: number,
    radius: number,
    out: Int32Array
  ): number => {
    const grid = self as Internal;
    const minC = cellCoord(grid, x - radius);
    const maxC = cellCoord(grid, x + radius);
    const minR = cellCoord(grid, y - radius);
    const maxR = cellCoord(grid, y + radius);
    let found = 0;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        for (
          let i = grid.head[r * grid.cols + c]!;
          i !== -1;
          i = grid.nextInCell[i]!
        ) {
          if (found === out.length) {
            return found;
          }
          out[found] = i;
          found += 1;
        }
      }
    }
    return found;
  }
);

/**
 * Writes into `out` the index of every point whose circle overlaps the circle of `radius` at
 * `(x, y)`, in `query`'s order, and returns how many.
 *
 * **When to use**
 *
 * For what a circle hits: an aura, a shot, a hero's body against the horde.
 *
 * **Details**
 *
 * Two circles overlap when the length between their centres is under the sum of their radii:
 * two that only touch do not. A grid built without radii tests centres. The cells of the build's
 * widest radius are visited too, so a caller pads nothing. A point is found from the cell it was
 * built in and tested where its arrays put it now; so is its radius: one raised since the build
 * is tested as it is now, and looked for no further than the build's widest. It stops when `out`
 * is full.
 *
 * **Example** (Hitting what a circle overlaps)
 *
 * ```ts
 * import { SpatialGrid } from "arcadekit/core";
 *
 * const grid = SpatialGrid.make({ halfSize: 10, cellSize: 2, capacity: 8 });
 * // One overlaps the circle, and one only touches it.
 * SpatialGrid.build(grid, [1.5, 2.25], [0, 0], 2, [0.5, 1]);
 * const out = new Int32Array(8);
 * const hit = SpatialGrid.within(grid, 0, 0, 1.25, out);
 * [...out.subarray(0, hit)]; // => [0]
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const within: {
  (
    x: number,
    y: number,
    radius: number,
    out: Int32Array
  ): (self: SpatialGrid) => number;
  (
    self: SpatialGrid,
    x: number,
    y: number,
    radius: number,
    out: Int32Array
  ): number;
} = dual(
  5,
  (
    self: SpatialGrid,
    x: number,
    y: number,
    radius: number,
    out: Int32Array
  ): number => {
    const grid = self as Internal;
    const { xs, ys, radii } = grid;
    const reach = radius + grid.widest;
    const minC = cellCoord(grid, x - reach);
    const maxC = cellCoord(grid, x + reach);
    const minR = cellCoord(grid, y - reach);
    const maxR = cellCoord(grid, y + reach);
    let found = 0;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        for (
          let i = grid.head[r * grid.cols + c]!;
          i !== -1;
          i = grid.nextInCell[i]!
        ) {
          const sum = radius + (radii === undefined ? 0 : radii[i]!);
          if (hypot2(xs[i]! - x, ys[i]! - y) < sum) {
            if (found === out.length) {
              return found;
            }
            out[found] = i;
            found += 1;
          }
        }
      }
    }
    return found;
  }
);

/**
 * The index of the point nearest `(x, y)` and closer than `range`, or -1. A tie goes to the
 * lower index. A point `i` with `skip[i]` not 0 is passed over.
 *
 * **When to use**
 *
 * To aim: the nearest enemy in a weapon's range, and the next one for a second shot, with the
 * first marked in `skip`.
 *
 * **Details**
 *
 * It measures to a point's centre, whatever its radius, and a point at exactly `range` is out.
 * `skip` is a mask its caller owns and fills: the points already taken, or dead. It is as long
 * as the points of the build, or longer, as a pool's field is, and a shorter one throws a
 * `RangeError`.
 *
 * **Example** (Aiming two shots)
 *
 * ```ts
 * import { SpatialGrid } from "arcadekit/core";
 *
 * const grid = SpatialGrid.make({ halfSize: 10, cellSize: 2, capacity: 8 });
 * SpatialGrid.build(grid, [3, 1, 6], [0, 0, 0], 3);
 * const taken = new Uint8Array(8);
 *
 * const first = SpatialGrid.nearest(grid, 0, 0, 5, taken);
 * first; // => 1
 * taken[first] = 1;
 * SpatialGrid.nearest(grid, 0, 0, 5, taken); // => 0
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const nearest: {
  (
    x: number,
    y: number,
    range: number,
    skip?: ArrayLike<number>
  ): (self: SpatialGrid) => number;
  (
    self: SpatialGrid,
    x: number,
    y: number,
    range: number,
    skip?: ArrayLike<number>
  ): number;
} = dual(
  gridFirst,
  (
    self: SpatialGrid,
    x: number,
    y: number,
    range: number,
    skip?: ArrayLike<number>
  ): number => {
    const grid = self as Internal;
    // Read past its end, a mask is not 0: it would pass over every point it does not cover.
    if (skip !== undefined && skip.length < grid.count) {
      throw new RangeError(
        `SpatialGrid.nearest needs a skip mask as long as the build's ${grid.count} points, got ${skip.length}`
      );
    }
    const { xs, ys } = grid;
    const minC = cellCoord(grid, x - range);
    const maxC = cellCoord(grid, x + range);
    const minR = cellCoord(grid, y - range);
    const maxR = cellCoord(grid, y + range);
    let best = -1;
    let bestD = range;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        for (
          let i = grid.head[r * grid.cols + c]!;
          i !== -1;
          i = grid.nextInCell[i]!
        ) {
          if (skip !== undefined && skip[i] !== 0) {
            continue;
          }
          const d = hypot2(xs[i]! - x, ys[i]! - y);
          // Cells come in no order of index, so the tie is settled here: the lower index.
          if (d < bestD || (d === bestD && i < best)) {
            best = i;
            bestD = d;
          }
        }
      }
    }
    return best;
  }
);
