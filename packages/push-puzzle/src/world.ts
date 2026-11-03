import { EventBuffer, createIdentifiedPool } from "@gamekit/core";
import type { IdentifiedPool } from "@gamekit/core";

import { Tile, parseLevel } from "./level";
import type { PuzzleContent } from "./schema";

// The push-puzzle simulation: plain data and plain functions, no Effect, no Three.js, no DOM.
// The runtime calls `step` on a fixed clock, but the game is played in turns: a step holds
// at most one turn (a move or an undo), and most steps hold none.
// Nothing is allocated per step or per turn.

export type Direction = "up" | "down" | "left" | "right";

/** One step's worth of input. */
export interface PushPuzzleInput {
  /** The direction held down now, if any. Holding it repeats the move. */
  readonly held: Direction | null;
  /** The direction pressed during this step, if any. Starts a move right away. */
  readonly pressed: Direction | null;
  /** Whether undo was pressed during this step. Fires once per press, never repeats. */
  readonly undo: boolean;
}

/** A run is one attempt at one level. */
export interface PushPuzzleConfig {
  readonly content: PuzzleContent;
  readonly levelId: string;
  /** How many turns undo can go back. Defaults to 2048; the oldest are dropped first. */
  readonly historyCapacity?: number;
}

export interface HudSnapshot {
  readonly moves: number;
  /** Goals that have no box on them yet. */
  readonly boxesLeft: number;
}

/** What a push-puzzle run reports to the outside. */
export type PushPuzzleEvent =
  | { readonly type: "hud"; readonly hud: HudSnapshot }
  | { readonly type: "levelSolved"; readonly moves: number };

const DEFAULT_HISTORY_CAPACITY = 2048;
/** Steps a held direction waits after its press before moving again. */
export const REPEAT_DELAY_STEPS = 12;
/** Steps between repeated moves after that. */
export const REPEAT_INTERVAL_STEPS = 6;

const BOX_LAYOUT = {
  /** Cell index, `row * cols + col`. */
  cell: Int32Array,
};

/**
 * Undo history: a ring of turn records in typed arrays, preallocated, so recording a turn
 * allocates nothing. When full, the oldest record is overwritten.
 */
interface History {
  readonly capacity: number;
  /** Where the player stood before the move. */
  readonly playerFrom: Int32Array;
  /** Stable id of the pushed box, or -1 if the move pushed nothing. */
  readonly boxId: Int32Array;
  /** Where the pushed box stood before the move. */
  readonly boxFrom: Int32Array;
  /** 1 if the pushed box filled a hole. */
  readonly filledHole: Uint8Array;
  /** Ring index of the oldest record. */
  oldest: number;
  length: number;
}

const createHistory = (capacity: number): History => ({
  capacity,
  playerFrom: new Int32Array(capacity),
  boxId: new Int32Array(capacity),
  boxFrom: new Int32Array(capacity),
  filledHole: new Uint8Array(capacity),
  oldest: 0,
  length: 0,
});

/** Returns the ring index for a new record, dropping the oldest record if the history is full. */
const pushRecord = (history: History): number => {
  if (history.length === history.capacity) {
    history.oldest = (history.oldest + 1) % history.capacity;
    history.length -= 1;
  }
  const i = (history.oldest + history.length) % history.capacity;
  history.length += 1;
  return i;
};

/** Returns the ring index of the newest record and forgets it, or -1 if the history is empty. */
const popRecord = (history: History): number => {
  if (history.length === 0) {
    return -1;
  }
  history.length -= 1;
  return (history.oldest + history.length) % history.capacity;
};

export interface Puzzle {
  readonly events: EventBuffer<PushPuzzleEvent>;
  /** The tile map. Cells are indexed `row * cols + col`. */
  readonly cols: number;
  readonly rows: number;
  /** One Tile per cell. Changes only when a hole is filled or reopened by undo. */
  readonly tiles: Uint8Array;
  /** 1 where a cell is a goal. */
  readonly goals: Uint8Array;
  readonly goalCount: number;
  /**
   * Every box still on the board. Pool indices move when a box is removed (filling a hole),
   * so undo and the view name a box by its stable id (`idOf`, `indexOf`), never by index.
   */
  readonly boxes: IdentifiedPool<typeof BOX_LAYOUT>;
  /** The player's cell. */
  player: number;
  /** Moves made, minus moves undone. */
  moves: number;
  /** Turns that changed the board, moves and undos alike. Only goes up, so the HUD sample can watch it. */
  turns: number;
  /** Set on the turn every goal gets a box. No further turns are taken. */
  solved: boolean;
  readonly history: History;
  /** The pressed direction that is still held, and steps until it moves again. Timed in steps, so replays are exact. */
  readonly repeat: { direction: Direction | null; stepsLeft: number };
}

export const createPuzzle = (
  { content, levelId, historyCapacity }: PushPuzzleConfig,
  // Push-puzzle has no randomness. The seed is part of the runtime's contract, so it's accepted.
  _seed: number
): Puzzle => {
  const level =
    content.levels.find((l) => l.id === levelId) ?? content.levels[0];
  const parsed = parseLevel(level.rows);
  // Boxes get ids 0, 1, 2… in level reading order. None is ever added after this, so an id
  // freed by filling a hole stays free until undo brings that box back.
  const boxes = createIdentifiedPool(parsed.boxes.length, BOX_LAYOUT);
  for (const cell of parsed.boxes) {
    boxes.fields.cell[boxes.add()] = cell;
  }
  return {
    events: new EventBuffer(),
    cols: parsed.cols,
    rows: parsed.rows,
    tiles: parsed.tiles,
    goals: parsed.goals,
    goalCount: parsed.goalCount,
    boxes,
    player: parsed.players[0] ?? 0,
    moves: 0,
    turns: 0,
    solved: false,
    history: createHistory(historyCapacity ?? DEFAULT_HISTORY_CAPACITY),
    repeat: { direction: null, stepsLeft: 0 },
  };
};

/** Advances the run by one step: takes at most one turn. `dt` is unused; turns are counted in steps. */
export const step = (
  puzzle: Puzzle,
  input: PushPuzzleInput,
  _dt: number
): void => {
  if (puzzle.solved) {
    return;
  }
  const { repeat } = puzzle;
  if (input.undo) {
    undoTurn(puzzle);
    // A direction held through an undo doesn't move until it's pressed again.
    repeat.direction = null;
    return;
  }
  if (input.pressed !== null) {
    repeat.direction = input.pressed;
    repeat.stepsLeft = REPEAT_DELAY_STEPS;
    takeMove(puzzle, input.pressed);
    return;
  }
  if (input.held === null || input.held !== repeat.direction) {
    // Released, or holding a direction that wasn't pressed: nothing repeats.
    repeat.direction = null;
    return;
  }
  repeat.stepsLeft -= 1;
  if (repeat.stepsLeft === 0) {
    repeat.stepsLeft = REPEAT_INTERVAL_STEPS;
    takeMove(puzzle, input.held);
  }
};

/** A move turn: moves if it can, and reports the solve on the move that completes the level. */
const takeMove = (puzzle: Puzzle, direction: Direction) => {
  if (tryMove(puzzle, direction) && boxesLeft(puzzle) === 0) {
    puzzle.solved = true;
    puzzle.events.push({ type: "levelSolved", moves: puzzle.moves });
  }
};

const COL_DELTA = { up: 0, down: 0, left: -1, right: 1 } as const;
const ROW_DELTA = { up: -1, down: 1, left: 0, right: 0 } as const;

/** The cell next to `cell` in `direction`, or -1 off the map. */
const neighbor = (puzzle: Puzzle, cell: number, direction: Direction) => {
  const col = (cell % puzzle.cols) + COL_DELTA[direction];
  const row = Math.floor(cell / puzzle.cols) + ROW_DELTA[direction];
  return col >= 0 && col < puzzle.cols && row >= 0 && row < puzzle.rows
    ? row * puzzle.cols + col
    : -1;
};

/** Pool index of the box on `cell`, or -1. */
const boxIndexAt = (puzzle: Puzzle, cell: number) => {
  const { boxes } = puzzle;
  for (let i = 0; i < boxes.count; i++) {
    if (boxes.fields.cell[i] === cell) {
      return i;
    }
  }
  return -1;
};

/** Moves the player, pushing a box if there is one. Returns whether a move was made. */
const tryMove = (puzzle: Puzzle, direction: Direction): boolean => {
  const target = neighbor(puzzle, puzzle.player, direction);
  if (target === -1 || puzzle.tiles[target] !== Tile.floor) {
    return false;
  }
  const box = boxIndexAt(puzzle, target);
  let boxId = -1;
  let filledHole = 0;
  if (box !== -1) {
    const beyond = neighbor(puzzle, target, direction);
    if (beyond === -1 || boxIndexAt(puzzle, beyond) !== -1) {
      return false;
    }
    const tile = puzzle.tiles[beyond];
    if (tile !== Tile.floor && tile !== Tile.hole) {
      return false;
    }
    boxId = puzzle.boxes.idOf(box);
    if (tile === Tile.hole) {
      // The box fills the hole: both are gone, and the cell is floor from now on.
      puzzle.tiles[beyond] = Tile.floor;
      puzzle.boxes.remove(box);
      filledHole = 1;
    } else {
      puzzle.boxes.fields.cell[box] = beyond;
    }
  }
  const { history } = puzzle;
  const record = pushRecord(history);
  history.playerFrom[record] = puzzle.player;
  history.boxId[record] = boxId;
  history.boxFrom[record] = target;
  history.filledHole[record] = filledHole;
  puzzle.player = target;
  puzzle.moves += 1;
  puzzle.turns += 1;
  return true;
};

/** Reverses the last recorded move exactly. Does nothing when the history is empty. */
const undoTurn = (puzzle: Puzzle): void => {
  const { history, boxes } = puzzle;
  const record = popRecord(history);
  if (record === -1) {
    return;
  }
  const playerFrom = history.playerFrom[record]!;
  const boxId = history.boxId[record]!;
  if (boxId !== -1) {
    const boxFrom = history.boxFrom[record]!;
    // The player pushed from playerFrom into boxFrom, so the box went one cell further the same way.
    const boxTo = boxFrom + (boxFrom - playerFrom);
    if (history.filledHole[record] === 1) {
      puzzle.tiles[boxTo] = Tile.hole;
      boxes.fields.cell[boxes.addWithId(boxId)] = boxFrom;
    } else {
      boxes.fields.cell[boxes.indexOf(boxId)] = boxFrom;
    }
  }
  puzzle.player = playerFrom;
  puzzle.moves -= 1;
  puzzle.turns += 1;
};

/** Stable id of the box at (col, row), or -1. */
export const boxIdAt = (puzzle: Puzzle, col: number, row: number): number => {
  const i = boxIndexAt(puzzle, row * puzzle.cols + col);
  return i === -1 ? -1 : puzzle.boxes.idOf(i);
};

/** Goals that have no box on them yet. */
export const boxesLeft = (puzzle: Puzzle): number => {
  let placed = 0;
  const { boxes } = puzzle;
  for (let i = 0; i < boxes.count; i++) {
    placed += puzzle.goals[boxes.fields.cell[i]!]!;
  }
  return puzzle.goalCount - placed;
};

export const hudSnapshot = (puzzle: Puzzle): HudSnapshot => ({
  moves: puzzle.moves,
  boxesLeft: boxesLeft(puzzle),
});

/** The board as level text, one string per row. For tests, debugging and replay checks; allocates. */
export const boardText = (puzzle: Puzzle): string[] => {
  const lines: string[] = [];
  for (let row = 0; row < puzzle.rows; row++) {
    let line = "";
    for (let col = 0; col < puzzle.cols; col++) {
      line += cellChar(puzzle, row * puzzle.cols + col);
    }
    lines.push(line.trimEnd());
  }
  return lines;
};

const cellChar = (puzzle: Puzzle, cell: number): string => {
  switch (puzzle.tiles[cell]) {
    case Tile.wall: {
      return "#";
    }
    case Tile.hole: {
      return "^";
    }
    case Tile.floor: {
      const goal = puzzle.goals[cell] === 1;
      if (cell === puzzle.player) {
        return goal ? "+" : "@";
      }
      if (boxIndexAt(puzzle, cell) !== -1) {
        return goal ? "*" : "$";
      }
      return goal ? "." : " ";
    }
    default: {
      return " ";
    }
  }
};
