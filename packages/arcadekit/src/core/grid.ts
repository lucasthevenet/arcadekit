import { hypot2 } from "./math";

export interface SpatialGridOptions {
  /** The grid covers [-halfSize, halfSize] on both axes. Points outside are clamped to the edge cells. */
  readonly halfSize: number;
  /** About the size of the largest query radius works well. */
  readonly cellSize: number;
  /** Maximum number of points per build: the capacity of the pool it indexes. */
  readonly capacity: number;
}

const NO_POINTS: ArrayLike<number> = [];

/**
 * Uniform 2D grid for "which points are near here?", rebuilt from scratch each step.
 * Uses linked lists in flat arrays, so building and asking allocate nothing.
 * Axes are called x and y; a 3D game on a ground plane passes z as y.
 *
 * `within` and `nearest` answer with the distance tested, with exact arithmetic (`hypot2`), so
 * every lockstep peer gets the same points. `query` gives the candidates of the cells a circle
 * overlaps, for a step that tests each pair itself.
 */
export class SpatialGrid {
  readonly cols: number;
  private readonly halfSize: number;
  private readonly cellSize: number;
  private readonly head: Int32Array;
  private readonly nextInCell: Int32Array;
  // What the last build was given. The grid reads them when asked, and never writes them.
  private xs: ArrayLike<number> = NO_POINTS;
  private ys: ArrayLike<number> = NO_POINTS;
  private radii: ArrayLike<number> | undefined = undefined;
  /** How many points the last build indexed. */
  private count = 0;
  /** The widest radius of the last build, or 0 for one without radii. */
  private widest = 0;

  constructor(options: SpatialGridOptions) {
    this.halfSize = options.halfSize;
    this.cellSize = options.cellSize;
    this.cols = Math.ceil((options.halfSize * 2) / options.cellSize);
    // -1 ends a cell's list, so a grid that was never built has no points.
    this.head = new Int32Array(this.cols * this.cols).fill(-1);
    this.nextInCell = new Int32Array(options.capacity);
  }

  private cellCoord(v: number): number {
    const c = Math.floor((v + this.halfSize) / this.cellSize);
    return Math.min(Math.max(c, 0), this.cols - 1);
  }

  /**
   * Indexes the first `count` points. Point i is (xs[i], ys[i]), and a circle of radius
   * `radii[i]` if `radii` is given. The grid keeps the three arrays and reads them when asked.
   *
   * Throws a RangeError for more points than the grid's capacity, and for fewer radii than
   * points, before it changes anything: the build it had stands.
   */
  build(
    xs: ArrayLike<number>,
    ys: ArrayLike<number>,
    count: number,
    radii?: ArrayLike<number>
  ): void {
    // A point past the capacity has no place in the cells' lists, so a walk of one never ends.
    if (count > this.nextInCell.length) {
      throw new RangeError(
        `SpatialGrid.build needs a count within the grid's capacity of ${this.nextInCell.length}, got ${count}`
      );
    }
    // And a point with no radius overlaps nothing: `within` would leave it out in silence.
    if (radii !== undefined && radii.length < count) {
      throw new RangeError(
        `SpatialGrid.build needs a radius for each of its ${count} points, got ${radii.length}`
      );
    }
    this.head.fill(-1);
    this.xs = xs;
    this.ys = ys;
    this.radii = radii;
    this.count = count;
    let widest = 0;
    for (let i = 0; i < count; i++) {
      const cell = this.cellCoord(ys[i]!) * this.cols + this.cellCoord(xs[i]!);
      this.nextInCell[i] = this.head[cell]!;
      this.head[cell] = i;
      if (radii !== undefined && radii[i]! > widest) {
        widest = radii[i]!;
      }
    }
    this.widest = widest;
  }

  /**
   * Writes into `out` the index of every point whose cell overlaps the circle, and returns how
   * many: the candidates, with no distance tested and no radius counted. `within` gives the
   * points that overlap the circle. Stops when `out` is full.
   */
  query(x: number, y: number, radius: number, out: Int32Array): number {
    const minC = this.cellCoord(x - radius);
    const maxC = this.cellCoord(x + radius);
    const minR = this.cellCoord(y - radius);
    const maxR = this.cellCoord(y + radius);
    let found = 0;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        for (
          let i = this.head[r * this.cols + c]!;
          i !== -1;
          i = this.nextInCell[i]!
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

  /**
   * Writes into `out` the index of every point whose circle overlaps the circle of `radius` at
   * (x, y), in `query`'s order, and returns how many. Stops when `out` is full.
   *
   * Two circles overlap when the length between their centres is under the sum of their radii:
   * two that only touch do not. A grid built without radii tests centres. The cells of the
   * build's widest radius are visited too, so a caller pads nothing. A point is found from the
   * cell it was built in and tested where its arrays put it now. So is its radius: one raised
   * since the build is tested as it is now, and looked for no further than the build's widest.
   * A step builds once its points have moved and their radii are set.
   */
  within(x: number, y: number, radius: number, out: Int32Array): number {
    const { xs, ys, radii } = this;
    const reach = radius + this.widest;
    const minC = this.cellCoord(x - reach);
    const maxC = this.cellCoord(x + reach);
    const minR = this.cellCoord(y - reach);
    const maxR = this.cellCoord(y + reach);
    let found = 0;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        for (
          let i = this.head[r * this.cols + c]!;
          i !== -1;
          i = this.nextInCell[i]!
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

  /**
   * The index of the point nearest (x, y) and closer than `range`, or -1. A tie goes to the
   * lower index. A point `i` with `skip[i]` not 0 is passed over.
   *
   * It measures to a point's centre, whatever its radius, and a point at exactly `range` is
   * out. `skip` is a mask its caller owns and fills: the points already taken, or dead. It is
   * as long as the points of the build, or longer, as a pool's field is.
   *
   * Throws a RangeError for a mask shorter than the build.
   */
  nearest(
    x: number,
    y: number,
    range: number,
    skip?: ArrayLike<number>
  ): number {
    // Read past its end, a mask is not 0: it would pass over every point it does not cover.
    if (skip !== undefined && skip.length < this.count) {
      throw new RangeError(
        `SpatialGrid.nearest needs a skip mask as long as the build's ${this.count} points, got ${skip.length}`
      );
    }
    const { xs, ys } = this;
    const minC = this.cellCoord(x - range);
    const maxC = this.cellCoord(x + range);
    const minR = this.cellCoord(y - range);
    const maxR = this.cellCoord(y + range);
    let best = -1;
    let bestD = range;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        for (
          let i = this.head[r * this.cols + c]!;
          i !== -1;
          i = this.nextInCell[i]!
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
}
