/**
 * Tile maps: a level's grid of static cells (wall, floor, hole), stored as one typed array per
 * field.
 *
 * A tile map says what the level is, not where entities are: those are in entity pools, and a
 * spatial grid finds them. A tile is a number in a field, not an object, so a state hash can walk
 * it, and `neighbor` and `flood` allocate nothing, so a step may call them.
 *
 * @since 0.7.0
 */
import type { Types } from "effect";
import { Inspectable, Pipeable, Predicate } from "effect";
import { dual } from "effect/Function";

import { allocate } from "./internal/fields";
import type * as Layout from "./layout";

const TypeId = "~arcadekit/core/TileMap";

/**
 * A side of a cell: the neighbour one column or one row away. North is the row above.
 *
 * **When to use**
 *
 * To ask for a cell's neighbour, or to turn a direction a player pressed into one.
 *
 * **Details**
 *
 * The sides are numbered in the order a flood looks around a cell: west, east, north, south. A
 * side is one of these four numbers; any other is a type error.
 *
 * **Example** (Moving a player one cell)
 *
 * ```ts
 * import { TileMap } from "arcadekit/core";
 *
 * const map = TileMap.make(4, 3, { tile: Uint8Array });
 * const DIRECTIONS = { up: TileMap.Side.north, right: TileMap.Side.east } as const;
 * const player = TileMap.cellAt(map, 1, 1);
 * TileMap.neighbor(map, player, DIRECTIONS.up); // => 1
 * TileMap.neighbor(map, player, DIRECTIONS.right); // => 6
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export const Side = { west: 0, east: 1, north: 2, south: 3 } as const;

/**
 * One of the four sides of a cell: `TileMap.Side.west`, `east`, `north` or `south`.
 *
 * **When to use**
 *
 * To type a parameter or a field that holds a side.
 *
 * **Example** (Keeping the side a player faces)
 *
 * ```ts
 * import { TileMap } from "arcadekit/core";
 *
 * let facing: TileMap.Side = TileMap.Side.south;
 * facing = TileMap.Side.west;
 * facing; // => 0
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Side = (typeof Side)[keyof typeof Side];

/** The sides, in the order `Side` numbers them: the order a flood looks around a cell in. */
const SIDES = [Side.west, Side.east, Side.north, Side.south] as const;
/** How many columns and rows away the neighbour on each side is, by its `Side`. */
const COL_DELTA = [-1, 1, 0, 0] as const;
const ROW_DELTA = [0, 0, -1, 1] as const;

/**
 * A grid of static cells, `cols` by `rows`, stored as one typed array per field of its layout.
 * Cell `row * cols + col`.
 *
 * **When to use**
 *
 * For a level: what each cell is (a wall, a floor, a hole, a goal), read and written by the
 * level's rules and drawn by its view.
 *
 * **Details**
 *
 * A column, a row and a cell are whole numbers: a position on the ground is floored first. A
 * cell off the map is -1, and every function that is handed one gives -1 or nothing back, so one
 * lookup can follow another with no test between them.
 *
 * **Example** (Reading a level's cells)
 *
 * ```ts
 * import { TileMap } from "arcadekit/core";
 *
 * const Tile = { floor: 0, wall: 1 } as const;
 * const map = TileMap.make(4, 3, { tile: Uint8Array, goal: Uint8Array });
 * map.fields.tile[TileMap.cellAt(map, 2, 1)] = Tile.wall;
 *
 * const target = TileMap.neighbor(map, TileMap.cellAt(map, 1, 1), TileMap.Side.east);
 * target; // => 6
 * map.fields.tile[target] === Tile.floor; // => false
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface TileMap<L extends Layout.Layout>
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  readonly cols: number;
  readonly rows: number;
  /** `cols * rows`: the length of every field. */
  readonly cells: number;
  /** One typed array per field of the layout, under the layout's names. */
  readonly fields: Layout.Fields<L>;
}

/** What the module's functions keep, which no caller reads. */
type Internal<L extends Layout.Layout> = Types.Mutable<TileMap<L>> & {
  /**
   * The cells a flood has marked and not yet looked around, made once. A flood marks a cell at
   * most once, so it never holds more than `cells`.
   */
  queue: Int32Array;
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: TileMap<Layout.Layout>) {
    return {
      _id: "TileMap",
      cols: this.cols,
      rows: this.rows,
      fields: Object.keys(this.fields),
    };
  },
};

/**
 * Checks whether a value is a tile map.
 *
 * **When to use**
 *
 * Narrow an unknown value before reading it as a level's cells.
 *
 * **Details**
 *
 * It looks for the tile map's marker, and checks nothing of its layout.
 *
 * **Example** (Recognising a tile map)
 *
 * ```ts
 * import { TileMap } from "arcadekit/core";
 *
 * TileMap.isTileMap(TileMap.make(2, 2, { tile: Uint8Array })); // => true
 * TileMap.isTileMap({ cols: 2, rows: 2 }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isTileMap = (value: unknown): value is TileMap<Layout.Layout> =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a tile map of `cols` by `rows` cells, with one typed array for each field of `layout`.
 * Every field of every cell starts at 0.
 *
 * **When to use**
 *
 * Once per level, when its state is made from the level's data.
 *
 * **Details**
 *
 * It throws a `RangeError` when `cols` or `rows` is not a whole number of 1 or more.
 *
 * **Example** (Making a level's map)
 *
 * ```ts
 * import { TileMap } from "arcadekit/core";
 *
 * const map = TileMap.make(4, 3, { tile: Uint8Array, height: Float32Array });
 * [map.cols, map.rows, map.cells]; // => [4, 3, 12]
 * map.fields.height.length; // => 12
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = <const L extends Layout.Layout>(
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
      `TileMap.make needs a whole number of columns and of rows, 1 or more of each, got ${cols} by ${rows}`
    );
  }
  const self = Object.create(Proto) as Internal<L>;
  self.cols = cols;
  self.rows = rows;
  self.cells = cols * rows;
  self.fields = allocate(layout, self.cells);
  self.queue = new Int32Array(self.cells);
  return self;
};

/**
 * The cell at `(col, row)`, or -1 off the map.
 *
 * **When to use**
 *
 * To turn a level's text or a position on the ground, floored, into a cell.
 *
 * **Details**
 *
 * A column past the east edge is no cell of the next row, which `row * cols + col` alone would
 * give: it is -1.
 *
 * **Example** (Finding cells by column and row)
 *
 * ```ts
 * import { TileMap } from "arcadekit/core";
 *
 * const map = TileMap.make(4, 3, { tile: Uint8Array });
 * TileMap.cellAt(map, 2, 1); // => 6
 * TileMap.cellAt(map, 4, 1); // => -1
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const cellAt: {
  (
    col: number,
    row: number
  ): <L extends Layout.Layout>(self: TileMap<L>) => number;
  <L extends Layout.Layout>(self: TileMap<L>, col: number, row: number): number;
} = dual(
  3,
  <L extends Layout.Layout>(
    self: TileMap<L>,
    col: number,
    row: number
  ): number =>
    col >= 0 && col < self.cols && row >= 0 && row < self.rows
      ? row * self.cols + col
      : -1
);

/**
 * The column of `cell`.
 *
 * **When to use**
 *
 * To draw a cell, or to compare where two cells are.
 *
 * **Example** (Reading a cell's column)
 *
 * ```ts
 * import { TileMap } from "arcadekit/core";
 *
 * const map = TileMap.make(4, 3, { tile: Uint8Array });
 * TileMap.colOf(map, 6); // => 2
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const colOf: {
  (cell: number): <L extends Layout.Layout>(self: TileMap<L>) => number;
  <L extends Layout.Layout>(self: TileMap<L>, cell: number): number;
} = dual(
  2,
  <L extends Layout.Layout>(self: TileMap<L>, cell: number): number =>
    cell % self.cols
);

/**
 * The row of `cell`.
 *
 * **When to use**
 *
 * To draw a cell, or to compare where two cells are.
 *
 * **Example** (Reading a cell's row)
 *
 * ```ts
 * import { TileMap } from "arcadekit/core";
 *
 * const map = TileMap.make(4, 3, { tile: Uint8Array });
 * TileMap.rowOf(map, 6); // => 1
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const rowOf: {
  (cell: number): <L extends Layout.Layout>(self: TileMap<L>) => number;
  <L extends Layout.Layout>(self: TileMap<L>, cell: number): number;
} = dual(2, <L extends Layout.Layout>(self: TileMap<L>, cell: number): number =>
  Math.floor(cell / self.cols)
);

/** The neighbour of `cell` on `side`, or -1: the work of `neighbor`, with nothing to dispatch. */
const neighborOf = <L extends Layout.Layout>(
  self: TileMap<L>,
  cell: number,
  side: Side
): number => {
  // A cell off the map has no column and row of its own: past the last, `cell % cols` would
  // give one of a row the map lacks, and its neighbour above would be on the map.
  if (cell < 0 || cell >= self.cells) {
    return -1;
  }
  const col = (cell % self.cols) + COL_DELTA[side];
  const row = Math.floor(cell / self.cols) + ROW_DELTA[side];
  return col >= 0 && col < self.cols && row >= 0 && row < self.rows
    ? row * self.cols + col
    : -1;
};

/**
 * The cell next to `cell` on `side`, or -1 off the map.
 *
 * **When to use**
 *
 * To move a player or a box one cell, or to look around a cell.
 *
 * **Details**
 *
 * The neighbour of a cell off the map, such as -1, is -1, and so is the neighbour on a side that
 * is none, which only a cast gets past the types.
 *
 * **Example** (Looking around a cell)
 *
 * ```ts
 * import { TileMap } from "arcadekit/core";
 *
 * const map = TileMap.make(4, 3, { tile: Uint8Array });
 * TileMap.neighbor(map, 5, TileMap.Side.north); // => 1
 * TileMap.neighbor(map, 3, TileMap.Side.east); // => -1
 * TileMap.neighbor(map, -1, TileMap.Side.south); // => -1
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const neighbor: {
  (
    cell: number,
    side: Side
  ): <L extends Layout.Layout>(self: TileMap<L>) => number;
  <L extends Layout.Layout>(self: TileMap<L>, cell: number, side: Side): number;
} = dual(3, neighborOf);

/**
 * Marks `start` in `reached` with 1, and every cell joined to it by sides through cells `passes`
 * accepts. Returns how many cells it marked.
 *
 * **When to use**
 *
 * To find what is reachable from a cell: the floor a player can walk to, the region a hole
 * drains, whether a level's goals are joined to its start.
 *
 * **Details**
 *
 * A cell already marked is not entered, so two floods can share a mask. `start` is marked
 * whatever `passes` says of it, unless it is marked already or off the map: then the flood marks
 * nothing. `passes` is asked of a cell before the flood enters it, and never once the cell is
 * marked.
 *
 * A step keeps `passes` as it keeps `reached`, so a flood allocates nothing; `passes` must not
 * flood the same map. It throws a `RangeError` for a `reached` shorter than `cells`, and marks
 * nothing.
 *
 * **Example** (Marking the floor a player can reach)
 *
 * ```ts
 * import { TileMap } from "arcadekit/core";
 *
 * // `#` is a wall: the floor at the top left is cut off from the rest.
 * const rows = ["..#.", ".#..", "#..."];
 * const map = TileMap.make(4, 3, { tile: Uint8Array });
 * rows.forEach((text, row) => {
 *   [...text].forEach((char, col) => {
 *     map.fields.tile[TileMap.cellAt(map, col, row)] = char === "#" ? 1 : 0;
 *   });
 * });
 *
 * const reached = new Uint8Array(map.cells);
 * const open = (cell: number) => map.fields.tile[cell] === 0;
 * TileMap.flood(map, 0, open, reached); // => 3
 * reached[TileMap.cellAt(map, 3, 2)]; // => 0
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const flood: {
  (
    start: number,
    passes: (cell: number) => boolean,
    reached: Uint8Array
  ): <L extends Layout.Layout>(self: TileMap<L>) => number;
  <L extends Layout.Layout>(
    self: TileMap<L>,
    start: number,
    passes: (cell: number) => boolean,
    reached: Uint8Array
  ): number;
} = dual(
  4,
  <L extends Layout.Layout>(
    self: TileMap<L>,
    start: number,
    passes: (cell: number) => boolean,
    reached: Uint8Array
  ): number => {
    const { cells } = self;
    const { queue } = self as Internal<L>;
    // Past its end, a typed array reads `undefined` and drops a write: a flood would stop there
    // and count too few, and say nothing.
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
        const next = neighborOf(self, cell, side);
        if (next !== -1 && reached[next] === 0 && passes(next)) {
          reached[next] = 1;
          queue[marked] = next;
          marked += 1;
        }
      }
    }
    return marked;
  }
);
