import { TileMap } from "arcadekit/core";

// Reading a level's text rows into a tile map. Used both to check content and to start a run.

/** What a tile-map cell holds. Boxes and the player are not tiles: they move. */
export const Tile = {
  /** Outside the walls: never reachable, not drawn. */
  void: 0,
  floor: 1,
  wall: 2,
  /** Blocks walking. A box pushed into it fills it and the cell becomes floor. */
  hole: 3,
} as const;
export type Tile = (typeof Tile)[keyof typeof Tile];

/** The characters a level row may use: standard Sokoban, plus `^` for a hole. */
export const LEVEL_CHARACTERS = "#@+$*. ^";

/** What a level's tile map holds for each cell. */
export const LEVEL_LAYOUT = {
  /** The cell's `Tile`. */
  tile: Uint8Array,
  /** 1 where the cell is a goal. */
  goal: Uint8Array,
};

interface ParsedLevel {
  /** The level's cells, row by row: cell index is `row * cols + col`. */
  readonly map: TileMap.TileMap<typeof LEVEL_LAYOUT>;
  readonly goalCount: number;
  /** Cell index of each player found. A valid level has exactly one. */
  readonly players: readonly number[];
  /** Cell index of each box, in reading order. */
  readonly boxes: readonly number[];
}

/** Parses rows of level text. Unknown characters count as walls; content checks reject them first. */
export const parseLevel = (rowsText: readonly string[]): ParsedLevel => {
  const rows = rowsText.length;
  // A level whose rows are all empty has no cell. It gets one column of void, so that the
  // content checks can say what it lacks: a map of no columns is refused.
  const cols = Math.max(1, ...rowsText.map((row) => row.length));
  // Every cell starts as `Tile.void`, which is 0.
  const map = TileMap.make(cols, rows, LEVEL_LAYOUT);
  const { tile, goal } = map.fields;
  const players: number[] = [];
  const boxes: number[] = [];
  let goalCount = 0;
  for (let row = 0; row < rows; row++) {
    const text = rowsText[row]!;
    for (let col = 0; col < text.length; col++) {
      const cell = TileMap.cellAt(map, col, row);
      const char = text[col]!;
      tile[cell] = charTile(char);
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

const charTile = (char: string): Tile => {
  if (char === "^") {
    return Tile.hole;
  }
  if (char === "#" || !LEVEL_CHARACTERS.includes(char)) {
    return Tile.wall;
  }
  return Tile.floor;
};

/** Turns every non-wall cell the player can't reach (ignoring boxes) into void, so the view skips it. */
const markOutside = (
  map: TileMap.TileMap<typeof LEVEL_LAYOUT>,
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
