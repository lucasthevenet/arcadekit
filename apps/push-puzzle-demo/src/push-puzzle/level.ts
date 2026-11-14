/**
 * Levels: a level's rows of text, read into the tile map a run plays on.
 *
 * A level is written in the standard Sokoban characters, plus `^` for a hole: `#` wall, space
 * floor, `@` player, `+` player on a goal, `$` box, `*` box on a goal, `.` goal and `^` hole.
 * `parse` reads the rows into a tile map of walls, floor and holes, with where the player and
 * the boxes start and how many goals there are. The content's Schema checks a level with it, and
 * a run starts from it.
 *
 * Plain on purpose: a run's `create` reads its level with `parse`, so it gives the same bits on
 * every peer and every replay; and reading text into typed arrays is pure data work.
 */
import { TileMap } from "arcadekit/core";

/**
 * What a cell of a level's tile map is: outside the walls, floor, a wall or a hole. Boxes and the
 * player are no tiles, since they move.
 *
 * **When to use**
 *
 * To read a cell of a run's map (`World.Puzzle`'s `map.fields.tile`), as the rules and the view
 * do.
 *
 * **Details**
 *
 * A tile is a number, so the map is one typed array. A hole blocks walking; a box pushed into it
 * fills it, and the cell is floor from then on, until an undo opens it again. `void` is floor the
 * player can't reach, which nothing draws.
 *
 * **Example** (A hole beside the player)
 *
 * ```ts
 * import { Level } from "#push-puzzle";
 *
 * const level = Level.parse(["####", "#@^#", "####"]);
 * level.map.fields.tile[5] === Level.Tile.floor; // => true
 * level.map.fields.tile[6] === Level.Tile.hole; // => true
 * ```
 *
 * @category models
 */
export const Tile = {
  /** Outside the walls: never reachable, not drawn. */
  void: 0,
  floor: 1,
  wall: 2,
  /** Blocks walking. A box pushed into it fills it and the cell becomes floor. */
  hole: 3,
} as const;

/**
 * One of the four tiles: `Level.Tile.void`, `floor`, `wall` or `hole`.
 *
 * **When to use**
 *
 * To type a value read from a map's `tile` field.
 *
 * **Example** (Naming a cell's tile)
 *
 * ```ts
 * import { Level } from "#push-puzzle";
 *
 * const level = Level.parse(["###", "#@#", "###"]);
 * const corner: Level.Tile = Level.Tile.wall;
 * level.map.fields.tile[0] === corner; // => true
 * ```
 *
 * @category models
 */
export type Tile = (typeof Tile)[keyof typeof Tile];

/**
 * Every character a level's row may use: the standard Sokoban ones, and `^` for a hole.
 *
 * **When to use**
 *
 * To check a level's text before it is played, as the content's Schema does.
 *
 * **Details**
 *
 * `parse` reads any other character as a wall, so a level is checked against these first.
 *
 * **Example** (Checking a row's characters)
 *
 * ```ts
 * import { Level } from "#push-puzzle";
 *
 * [..."#@$.^"].every((char) => Level.characters.includes(char)); // => true
 * Level.characters.includes("x"); // => false
 * ```
 *
 * @category models
 */
export const characters = "#@+$*. ^";

/**
 * What a level's tile map holds for each cell: its tile, and whether it is a goal.
 *
 * **When to use**
 *
 * To type a level's tile map (`TileMap.TileMap<typeof Level.layout>`), as `World.Puzzle` does.
 *
 * **Example** (The fields of a level's map)
 *
 * ```ts
 * import { Level } from "#push-puzzle";
 *
 * Object.keys(Level.layout); // => ["tile", "goal"]
 * Level.parse(["#####", "#@$.#", "#####"]).map.fields.goal[8]; // => 1
 * ```
 *
 * @category models
 */
export const layout = {
  /** The cell's `Tile`. */
  tile: Uint8Array,
  /** 1 where the cell is a goal. */
  goal: Uint8Array,
};

/**
 * A level read from its text: its tile map, and where the player and the boxes start.
 *
 * **When to use**
 *
 * To start a run from a level, or to check that a level can be played.
 *
 * **Details**
 *
 * Cells are numbered row by row, `row * cols + col`, as a tile map's are. The lists hold what the
 * text holds, so a level that can't be played has no player, or several: the content's Schema
 * refuses it, and a run only ever starts from a level that has one.
 *
 * **Example** (Where things start)
 *
 * ```ts
 * import { Level } from "#push-puzzle";
 *
 * const level = Level.parse(["#####", "#@$.#", "#####"]);
 * [level.players, level.boxes, level.goalCount]; // => [[6], [7], 1]
 * ```
 *
 * @category models
 */
export interface Level {
  /** The level's cells, row by row: cell index is `row * cols + col`. */
  readonly map: TileMap.TileMap<typeof layout>;
  readonly goalCount: number;
  /** Cell index of each player found. A level that can be played has exactly one. */
  readonly players: readonly number[];
  /** Cell index of each box, in reading order. */
  readonly boxes: readonly number[];
}

/**
 * Reads a level's rows of text into its tile map.
 *
 * **When to use**
 *
 * When a run starts on a level, and when the level is checked.
 *
 * **Details**
 *
 * The map is as wide as the longest row, and a shorter row's missing cells are outside the
 * walls. Floor the player can't reach, ignoring boxes, is `Tile.void`, so the view draws only
 * what is inside the walls. A character that isn't one of `characters` is read as a wall. Rows
 * that are all empty make a map of one column, every cell void, so a check can say what the
 * level lacks. It allocates: it runs once per run, not per step.
 *
 * **Example** (Floor outside the walls)
 *
 * ```ts
 * import { Level } from "#push-puzzle";
 *
 * const level = Level.parse(["  ###", "  #@#", "  ###"]);
 * [level.map.cols, level.map.rows]; // => [5, 3]
 * level.map.fields.tile[0] === Level.Tile.void; // => true
 * level.map.fields.tile[8] === Level.Tile.floor; // => true
 * ```
 *
 * @category constructors
 */
export const parse = (rows: readonly string[]): Level => {
  const rowCount = rows.length;
  // A level whose rows are all empty has no cell. It gets one column of void, so that the
  // content checks can say what it lacks: a map of no columns is refused.
  const cols = Math.max(1, ...rows.map((row) => row.length));
  // Every cell starts as `Tile.void`, which is 0.
  const map = TileMap.make(cols, rowCount, layout);
  const { tile, goal } = map.fields;
  const players: number[] = [];
  const boxes: number[] = [];
  let goalCount = 0;
  for (let row = 0; row < rowCount; row++) {
    const text = rows[row]!;
    for (let col = 0; col < text.length; col++) {
      const cell = TileMap.cellAt(map, col, row);
      const char = text[col]!;
      tile[cell] = tileOf(char);
      if (char === "@" || char === "+") {
        players.push(cell);
      }
      if (char === "$" || char === "*") {
        boxes.push(cell);
      }
      if (char === "." || char === "+" || char === "*") {
        goal[cell] = 1;
        goalCount += 1;
      }
    }
  }
  markOutside(map, players[0]);
  return { map, goalCount, players, boxes };
};

const tileOf = (char: string): Tile => {
  if (char === "^") {
    return Tile.hole;
  }
  if (char === "#" || !characters.includes(char)) {
    return Tile.wall;
  }
  return Tile.floor;
};

/** Turns every non-wall cell the player can't reach (ignoring boxes) into void, so the view skips it. */
const markOutside = (
  map: TileMap.TileMap<typeof layout>,
  start: number | undefined
) => {
  if (start === undefined) {
    return;
  }
  const { tile } = map.fields;
  const reached = new Uint8Array(map.cells);
  TileMap.flood(map, start, (cell) => tile[cell] !== Tile.wall, reached);
  for (let cell = 0; cell < map.cells; cell++) {
    if (reached[cell] === 0 && tile[cell] !== Tile.wall) {
      tile[cell] = Tile.void;
    }
  }
};
