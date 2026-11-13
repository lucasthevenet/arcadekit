import type { PoolFields, PoolLayout } from "./pool";

// A tile map: a level's grid of static cells (wall, floor, hole), stored as a pool's entities
// are, one typed array per field. It says what the level is, not where entities are: those are
// in pools, and a `SpatialGrid` finds them. A tile is a number in a field, not an object, so a
// state hash can walk it. `neighbor` and `flood` allocate nothing, so a step may call them.

/** A side of a cell: the neighbour one column or one row away. North is the row above. */
export const Side = { west: 0, east: 1, north: 2, south: 3 } as const;
export type Side = (typeof Side)[keyof typeof Side];

/** The sides, in the order `Side` numbers them: the order a flood looks around a cell in. */
const SIDES = [Side.west, Side.east, Side.north, Side.south] as const;
/** How many columns and rows away the neighbour on each side is, by its `Side`. */
const COL_DELTA = [-1, 1, 0, 0] as const;
const ROW_DELTA = [0, 0, -1, 1] as const;

/**
 * A grid of static cells, stored as one typed array per field. Cell `row * cols + col`.
 *
 * A column, a row and a cell are whole numbers: a position on the ground is floored first.
 */
export interface TileMap<L extends PoolLayout> {
  readonly cols: number;
  readonly rows: number;
  /** `cols * rows`: the length of every field. */
  readonly cells: number;
  readonly fields: PoolFields<L>;
  /** The cell at (col, row), or -1 off the map. */
  readonly cellAt: (col: number, row: number) => number;
  readonly colOf: (cell: number) => number;
  readonly rowOf: (cell: number) => number;
  /**
   * The cell next to `cell` on `side`, or -1 off the map. The neighbour of a cell off the map,
   * such as -1, is -1.
   */
  readonly neighbor: (cell: number, side: Side) => number;
  /**
   * Marks `start` in `reached` with 1, and every cell joined to it by sides through cells
   * `passes` accepts. A cell already marked is not entered, so two floods can share a mask.
   * Returns how many cells it marked.
   *
   * `start` is marked whatever `passes` says of it, unless it is marked already or off the
   * map: then the flood marks nothing. A step keeps `passes` as it keeps `reached`, so a flood
   * allocates nothing; `passes` must not flood the same map.
   *
   * Throws a `RangeError` for a `reached` shorter than `cells`.
   */
  readonly flood: (
    start: number,
    passes: (cell: number) => boolean,
    reached: Uint8Array
  ) => number;
}

/**
 * Makes a tile map of `cols` by `rows` cells, with one typed array for each field of `layout`.
 * Every field of every cell starts at 0.
 *
 * ```ts
 * const map = createTileMap(cols, rows, { tile: Uint8Array, goal: Uint8Array });
 * const target = map.neighbor(puzzle.player, Side.east);
 * if (target !== -1 && map.fields.tile[target] === Tile.floor) {
 *   puzzle.player = target;
 * }
 * ```
 *
 * Throws a `RangeError` when `cols` or `rows` is not a whole number of 1 or more.
 */
export const createTileMap = <const L extends PoolLayout>(
  cols: number,
  rows: number,
  layout: L
): TileMap<L> => {
  if (
    !Number.isInteger(cols) ||
    cols < 1 ||
    !Number.isInteger(rows) ||
    rows < 1
  ) {
    throw new RangeError(
      `createTileMap needs a whole number of columns and of rows, 1 or more of each, got ${cols} by ${rows}`
    );
  }
  const cells = cols * rows;
  const fields = Object.fromEntries(
    Object.entries(layout).map(([name, ArrayType]) => [
      name,
      new ArrayType(cells),
    ])
  ) as unknown as PoolFields<L>;
  // The cells a flood has marked and not yet looked around, made once. A flood marks a cell at
  // most once, so it never holds more than `cells`.
  const queue = new Int32Array(cells);
  const neighbor = (cell: number, side: Side): number => {
    // A cell off the map has no column and row of its own: past the last, `cell % cols` would
    // give one of a row the map lacks, and its neighbour above would be on the map.
    if (cell < 0 || cell >= cells) {
      return -1;
    }
    const col = (cell % cols) + COL_DELTA[side];
    const row = Math.floor(cell / cols) + ROW_DELTA[side];
    return col >= 0 && col < cols && row >= 0 && row < rows
      ? row * cols + col
      : -1;
  };
  return {
    cols,
    rows,
    cells,
    fields,
    cellAt: (col, row) =>
      col >= 0 && col < cols && row >= 0 && row < rows ? row * cols + col : -1,
    colOf: (cell) => cell % cols,
    rowOf: (cell) => Math.floor(cell / cols),
    neighbor,
    flood: (start, passes, reached) => {
      // Past its end, a typed array reads `undefined` and drops a write: a flood would stop
      // there and count too few, and say nothing.
      if (reached.length < cells) {
        throw new RangeError(
          `TileMap.flood needs a reached mask as long as the map's ${cells} cells, got ${reached.length}`
        );
      }
      if (start < 0 || start >= cells || reached[start] !== 0) {
        return 0;
      }
      reached[start] = 1;
      queue[0] = start;
      let marked = 1;
      for (let looked = 0; looked < marked; looked++) {
        const cell = queue[looked]!;
        for (const side of SIDES) {
          const next = neighbor(cell, side);
          if (next !== -1 && reached[next] === 0 && passes(next)) {
            reached[next] = 1;
            queue[marked] = next;
            marked += 1;
          }
        }
      }
      return marked;
    },
  };
};
