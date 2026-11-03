export interface SpatialGridOptions {
  /** The grid covers [-halfSize, halfSize] on both axes. Points outside are clamped to the edge cells. */
  readonly halfSize: number
  /** About the size of the largest query radius works well. */
  readonly cellSize: number
  /** Maximum number of points per build. */
  readonly capacity: number
}

/**
 * Uniform 2D grid for "which points are near here?", rebuilt from scratch each step.
 * Uses linked lists in flat arrays, so building and querying allocate nothing.
 * Axes are called x and y; a 3D game on a ground plane passes z as y.
 */
export class SpatialGrid {
  readonly cols: number
  private readonly halfSize: number
  private readonly cellSize: number
  private readonly head: Int32Array
  private readonly nextInCell: Int32Array

  constructor(options: SpatialGridOptions) {
    this.halfSize = options.halfSize
    this.cellSize = options.cellSize
    this.cols = Math.ceil((options.halfSize * 2) / options.cellSize)
    this.head = new Int32Array(this.cols * this.cols)
    this.nextInCell = new Int32Array(options.capacity)
  }

  private cellCoord(v: number): number {
    const c = Math.floor((v + this.halfSize) / this.cellSize)
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c
  }

  /** Indexes the first `count` points. Point i is (xs[i], ys[i]). */
  build(xs: ArrayLike<number>, ys: ArrayLike<number>, count: number): void {
    this.head.fill(-1)
    for (let i = 0; i < count; i++) {
      const cell = this.cellCoord(ys[i]!) * this.cols + this.cellCoord(xs[i]!)
      this.nextInCell[i] = this.head[cell]!
      this.head[cell] = i
    }
  }

  /**
   * Writes into `out` the index of every point whose cell overlaps the circle, and returns how many.
   * Callers still check the exact distance. Stops when `out` is full.
   */
  query(x: number, y: number, radius: number, out: Int32Array): number {
    const minC = this.cellCoord(x - radius)
    const maxC = this.cellCoord(x + radius)
    const minR = this.cellCoord(y - radius)
    const maxR = this.cellCoord(y + radius)
    let found = 0
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        for (let i = this.head[r * this.cols + c]!; i !== -1; i = this.nextInCell[i]!) {
          if (found === out.length) return found
          out[found++] = i
        }
      }
    }
    return found
  }
}
