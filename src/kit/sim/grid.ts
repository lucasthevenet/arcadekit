/**
 * Uniform spatial grid over the square arena, rebuilt every step.
 * Answers "which enemies are near this point?" without checking every enemy.
 * Uses linked lists in flat arrays, so building it allocates nothing.
 */
export class SpatialGrid {
  readonly cols: number
  private readonly head: Int32Array
  private readonly nextInCell: Int32Array

  constructor(
    private readonly halfSize: number,
    private readonly cellSize: number,
    capacity: number,
  ) {
    this.cols = Math.ceil((halfSize * 2) / cellSize)
    this.head = new Int32Array(this.cols * this.cols)
    this.nextInCell = new Int32Array(capacity)
  }

  private cellCoord(v: number): number {
    const c = Math.floor((v + this.halfSize) / this.cellSize)
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c
  }

  build(xs: Float32Array, zs: Float32Array, count: number): void {
    this.head.fill(-1)
    for (let i = 0; i < count; i++) {
      const cell = this.cellCoord(zs[i]!) * this.cols + this.cellCoord(xs[i]!)
      this.nextInCell[i] = this.head[cell]!
      this.head[cell] = i
    }
  }

  /**
   * Writes into `out` the index of every entry whose cell overlaps the circle, and returns how many.
   * Callers still check the exact distance. Stops when `out` is full.
   */
  query(x: number, z: number, radius: number, out: Int32Array): number {
    const minC = this.cellCoord(x - radius)
    const maxC = this.cellCoord(x + radius)
    const minR = this.cellCoord(z - radius)
    const maxR = this.cellCoord(z + radius)
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
