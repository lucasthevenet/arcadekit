import { Side, createIdentifiedPool, createRing } from "arcadekit/core";
import type { IdentifiedPool, Ring, TileMap } from "arcadekit/core";
import type * as Game from "arcadekit/game";
import { Schema } from "effect";

import { LevelSolved } from "./events";
import { Tile, parseLevel } from "./level";
import type { LEVEL_LAYOUT } from "./level";
import type { PuzzleContent } from "./schema";

// The push-puzzle simulation: plain data and plain functions, no Effect, no Three.js, no DOM.
// The loop calls `step` on a fixed clock, but the game is played in turns: a step holds
// at most one turn (a move or an undo), and most steps hold none.
// Nothing is allocated per step or per turn, but the one event a solve reports.

export const Direction = Schema.Literals(["up", "down", "left", "right"]);
export type Direction = typeof Direction.Type;

/** One step's worth of input. */
export const PushPuzzleInput = Schema.Struct({
  /** The direction held down now, if any. Holding it repeats the move. */
  held: Schema.NullOr(Direction),
  /** The direction pressed during this step, if any. Starts a move right away. */
  pressed: Schema.NullOr(Direction),
  /** Whether undo was pressed during this step. Fires once per press, never repeats. */
  undo: Schema.Boolean,
});
export type PushPuzzleInput = typeof PushPuzzleInput.Type;

/** A run is one attempt at one level. */
export interface PushPuzzleConfig {
  readonly content: PuzzleContent;
  /** The level to play. Must be one of `content`'s levels: `createPuzzle` throws otherwise. */
  readonly levelId: string;
  /**
   * How many turns undo can go back, a whole number of 1 or more: `createPuzzle` throws
   * otherwise. Defaults to 2048; the oldest are dropped first.
   */
  readonly historyCapacity?: number;
}

const DEFAULT_HISTORY_CAPACITY = 2048;
/** Steps a held direction waits after its press before moving again. */
const REPEAT_DELAY_STEPS = 12;
/** Steps between repeated moves after that. */
const REPEAT_INTERVAL_STEPS = 6;

const BOX_LAYOUT = {
  /** Cell index, `row * cols + col`. */
  cell: Int32Array,
};

/**
 * Undo history: a ring of turn records, so recording a turn allocates nothing. The rules pop
 * it, so it is state. When full, the oldest record is overwritten.
 */
const HISTORY_LAYOUT = {
  /** Where the player stood before the move. */
  playerFrom: Int32Array,
  /** Stable id of the pushed box, or -1 if the move pushed nothing. */
  boxId: Int32Array,
  /** Where the pushed box stood before the move. */
  boxFrom: Int32Array,
  /** 1 if the pushed box filled a hole. */
  filledHole: Uint8Array,
};

/** What a record of `Puzzle.changes` says a turn did. */
export const Change = {
  /** A box fell into a hole and filled it: `box` is the box's id and `cell` the hole's cell. */
  holeFilled: 1,
  /** A turn was undone. Its `box` and `cell` are -1. */
  undone: 2,
} as const;
export type Change = (typeof Change)[keyof typeof Change];

const CHANGE_LAYOUT = {
  /** A `Change`. */
  kind: Uint8Array,
  /** Stable id of the box that filled a hole. */
  box: Int32Array,
  /** The hole's cell. */
  cell: Int32Array,
};

/**
 * How many records `Puzzle.changes` holds. The engine's frame runs at most five steps
 * (`maxStepsPerFrame`) and a step holds at most one turn, so a view that looks on every frame
 * loses nothing.
 */
const CHANGES_CAPACITY = 8;

/**
 * Sound triggers: running totals of the moments that make a sound. The step bumps them and
 * never reads them, and undo leaves them alone, so they only go up during a run. A sound view
 * plays a sound for each one that rose since its last frame (ADR-0014).
 */
export interface PushPuzzleCues {
  /** Turns that moved the player without pushing a box. */
  moves: number;
  /** Turns that pushed a box, including into a hole. */
  pushes: number;
  /** Boxes that fell into a hole and filled it. */
  holesFilled: number;
  /** Turns undone. An undo with no history left doesn't count. */
  undos: number;
  /** 1 once the level is solved. */
  solved: number;
}

export interface Puzzle {
  /**
   * The tile map: for each cell, its `Tile` in the field `tile`, and 1 in `goal` where it is a
   * goal. Cells are indexed `row * cols + col`. A cell's tile changes only when a hole is
   * filled or reopened by undo.
   */
  readonly map: TileMap<typeof LEVEL_LAYOUT>;
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
  /** One record for each turn undo can take back, newest last. The rules pop it, so it is state. */
  readonly history: Ring<typeof HISTORY_LAYOUT>;
  /**
   * What a turn did that the board no longer shows after it: a box that filled a hole, which is
   * gone with it, and an undo. A ring the view alone reads: the rules push to it and never read
   * it back. Not part of the replay's end state.
   */
  readonly changes: Ring<typeof CHANGE_LAYOUT>;
  /** The pressed direction that is still held, and steps until it moves again. Timed in steps, so replays are exact. */
  readonly repeat: { direction: Direction | null; stepsLeft: number };
  /** Sound triggers, read by the presentation only. Not part of the replay's end state. */
  readonly cues: PushPuzzleCues;
}

// Push-puzzle has no randomness, so a run needs no seed.
export const createPuzzle = ({
  content,
  levelId,
  historyCapacity,
}: PushPuzzleConfig): Puzzle => {
  const level = content.levels.find((l) => l.id === levelId);
  if (level === undefined) {
    // Decoded content only holds levels that can be played, so this is the caller's mistake.
    throw new Error(`push-puzzle content has no level "${levelId}"`);
  }
  const turnsKept = historyCapacity ?? DEFAULT_HISTORY_CAPACITY;
  if (!Number.isInteger(turnsKept) || turnsKept < 1) {
    // `createRing` refuses it too, by a name the game never wrote.
    throw new RangeError(
      `push-puzzle's historyCapacity must be a whole number of 1 or more, got ${turnsKept}`
    );
  }
  const parsed = parseLevel(level.rows);
  // The schema rejects a level without exactly one player.
  const player = parsed.players[0]!;
  // Boxes get ids 0, 1, 2… in level reading order. None is ever added after this, so an id
  // freed by filling a hole stays free until undo brings that box back.
  const boxes = createIdentifiedPool(parsed.boxes.length, BOX_LAYOUT);
  for (const cell of parsed.boxes) {
    boxes.fields.cell[boxes.add()] = cell;
  }
  return {
    map: parsed.map,
    goalCount: parsed.goalCount,
    boxes,
    player,
    moves: 0,
    turns: 0,
    solved: false,
    history: createRing(turnsKept, HISTORY_LAYOUT),
    changes: createRing(CHANGES_CAPACITY, CHANGE_LAYOUT),
    repeat: { direction: null, stepsLeft: 0 },
    cues: { moves: 0, pushes: 0, holesFilled: 0, undos: 0, solved: 0 },
  };
};

/** Advances the run by one step: takes at most one turn. The step's `dt` is unused; turns are counted in steps. */
export const step = (
  puzzle: Puzzle,
  input: PushPuzzleInput,
  { report }: Game.StepContext<LevelSolved>
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
    takeMove(puzzle, input.pressed, report);
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
    takeMove(puzzle, input.held, report);
  }
};

/** A move turn: moves if it can, and reports the solve on the move that completes the level. */
const takeMove = (
  puzzle: Puzzle,
  direction: Direction,
  report: (event: LevelSolved) => void
) => {
  if (tryMove(puzzle, direction) && boxesLeft(puzzle) === 0) {
    puzzle.solved = true;
    puzzle.cues.solved += 1;
    report(new LevelSolved({ moves: puzzle.moves }));
  }
};

/** The side of a cell each direction moves to. Row 0 is the top of the board, so up is north. */
const SIDE = {
  up: Side.north,
  down: Side.south,
  left: Side.west,
  right: Side.east,
} as const;

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
  const { map } = puzzle;
  const { tile } = map.fields;
  const side = SIDE[direction];
  const target = map.neighbor(puzzle.player, side);
  if (target === -1 || tile[target] !== Tile.floor) {
    return false;
  }
  const box = boxIndexAt(puzzle, target);
  let boxId = -1;
  let filledHole = 0;
  if (box !== -1) {
    const beyond = map.neighbor(target, side);
    if (beyond === -1 || boxIndexAt(puzzle, beyond) !== -1) {
      return false;
    }
    const under = tile[beyond];
    if (under !== Tile.floor && under !== Tile.hole) {
      return false;
    }
    boxId = puzzle.boxes.idOf(box);
    if (under === Tile.hole) {
      // The box fills the hole: both are gone, and the cell is floor from now on.
      tile[beyond] = Tile.floor;
      puzzle.boxes.remove(box);
      filledHole = 1;
      const { changes } = puzzle;
      const change = changes.push();
      changes.fields.kind[change] = Change.holeFilled;
      changes.fields.box[change] = boxId;
      changes.fields.cell[change] = beyond;
    } else {
      puzzle.boxes.fields.cell[box] = beyond;
    }
  }
  const { history } = puzzle;
  const record = history.push();
  history.fields.playerFrom[record] = puzzle.player;
  history.fields.boxId[record] = boxId;
  history.fields.boxFrom[record] = target;
  history.fields.filledHole[record] = filledHole;
  puzzle.player = target;
  puzzle.moves += 1;
  puzzle.turns += 1;
  if (boxId === -1) {
    puzzle.cues.moves += 1;
  } else {
    puzzle.cues.pushes += 1;
    puzzle.cues.holesFilled += filledHole;
  }
  return true;
};

/** Reverses the last recorded move exactly. Does nothing when the history is empty. */
const undoTurn = (puzzle: Puzzle): void => {
  const { history, boxes, changes } = puzzle;
  const record = history.pop();
  if (record === -1) {
    return;
  }
  const playerFrom = history.fields.playerFrom[record]!;
  const boxId = history.fields.boxId[record]!;
  if (boxId !== -1) {
    const boxFrom = history.fields.boxFrom[record]!;
    // The player pushed from playerFrom into boxFrom, so the box went one cell further the same way.
    const boxTo = boxFrom + (boxFrom - playerFrom);
    if (history.fields.filledHole[record] === 1) {
      puzzle.map.fields.tile[boxTo] = Tile.hole;
      boxes.fields.cell[boxes.addWithId(boxId)] = boxFrom;
    } else {
      boxes.fields.cell[boxes.indexOf(boxId)] = boxFrom;
    }
  }
  puzzle.player = playerFrom;
  puzzle.moves -= 1;
  puzzle.turns += 1;
  // The cues stay as they are: undo is a sound of its own, never a move counted back down.
  puzzle.cues.undos += 1;
  const change = changes.push();
  changes.fields.kind[change] = Change.undone;
  changes.fields.box[change] = -1;
  changes.fields.cell[change] = -1;
};

/** Stable id of the box at (col, row), or -1. */
export const boxIdAt = (puzzle: Puzzle, col: number, row: number): number => {
  const i = boxIndexAt(puzzle, puzzle.map.cellAt(col, row));
  return i === -1 ? -1 : puzzle.boxes.idOf(i);
};

/** Goals that have no box on them yet. */
const boxesLeft = (puzzle: Puzzle): number => {
  let placed = 0;
  const { boxes } = puzzle;
  const { goal } = puzzle.map.fields;
  for (let i = 0; i < boxes.count; i++) {
    placed += goal[boxes.fields.cell[i]!]!;
  }
  return puzzle.goalCount - placed;
};

/** What the `Hud` sample carries. */
export const hudSample = (
  puzzle: Puzzle
): { readonly moves: number; readonly boxesLeft: number } => ({
  moves: puzzle.moves,
  boxesLeft: boxesLeft(puzzle),
});

/** The board as level text, one string per row. For tests, debugging and replay checks; allocates. */
export const boardText = (puzzle: Puzzle): string[] => {
  const lines: string[] = [];
  const { map } = puzzle;
  for (let row = 0; row < map.rows; row++) {
    let line = "";
    for (let col = 0; col < map.cols; col++) {
      line += cellChar(puzzle, map.cellAt(col, row));
    }
    lines.push(line.trimEnd());
  }
  return lines;
};

const cellChar = (puzzle: Puzzle, cell: number): string => {
  switch (puzzle.map.fields.tile[cell]) {
    case Tile.wall: {
      return "#";
    }
    case Tile.hole: {
      return "^";
    }
    case Tile.floor: {
      const goal = puzzle.map.fields.goal[cell] === 1;
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
