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

interface ParsedLevel {
  readonly cols: number;
  readonly rows: number;
  /** One Tile per cell, row by row: cell index is `row * cols + col`. */
  readonly tiles: Uint8Array;
  /** 1 where a cell is a goal. */
  readonly goals: Uint8Array;
  readonly goalCount: number;
  /** Cell index of each player found. A valid level has exactly one. */
  readonly players: readonly number[];
  /** Cell index of each box, in reading order. */
  readonly boxes: readonly number[];
}

/** Parses rows of level text. Unknown characters count as walls; content checks reject them first. */
export const parseLevel = (rowsText: readonly string[]): ParsedLevel => {
  const rows = rowsText.length;
  const cols = Math.max(...rowsText.map((row) => row.length));
  const tiles = new Uint8Array(cols * rows).fill(Tile.void);
  const goals = new Uint8Array(cols * rows);
  const players: number[] = [];
  const boxes: number[] = [];
  let goalCount = 0;
  for (let row = 0; row < rows; row++) {
    const text = rowsText[row]!;
    for (let col = 0; col < text.length; col++) {
      const cell = row * cols + col;
      const char = text[col]!;
      tiles[cell] = charTile(char);
      if (char === "@" || char === "+") {
        players.push(cell);
      }
      if (char === "$" || char === "*") {
        boxes.push(cell);
      }
      if (char === "." || char === "+" || char === "*") {
        goals[cell] = 1;
        goalCount += 1;
      }
    }
  }
  markOutside(tiles, cols, rows, players[0]);
  return { cols, rows, tiles, goals, goalCount, players, boxes };
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
  tiles: Uint8Array,
  cols: number,
  rows: number,
  start: number | undefined
) => {
  if (start === undefined) {
    return;
  }
  const reached = new Uint8Array(tiles.length);
  const stack = [start];
  reached[start] = 1;
  while (stack.length > 0) {
    const cell = stack.pop()!;
    const col = cell % cols;
    const row = Math.floor(cell / cols);
    for (const [dc, dr] of NEIGHBORS) {
      const c = col + dc;
      const r = row + dr;
      const next = r * cols + c;
      if (
        c >= 0 &&
        c < cols &&
        r >= 0 &&
        r < rows &&
        reached[next] === 0 &&
        tiles[next] !== Tile.wall
      ) {
        reached[next] = 1;
        stack.push(next);
      }
    }
  }
  for (let cell = 0; cell < tiles.length; cell++) {
    if (reached[cell] === 0 && tiles[cell] !== Tile.wall) {
      tiles[cell] = Tile.void;
    }
  }
};

const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
