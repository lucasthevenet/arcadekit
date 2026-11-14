/**
 * The push-puzzle world: a run's state, the `Puzzle`, and the step that plays it.
 *
 * The loop calls `step` on a fixed clock, but the game is played in turns: a step holds at most
 * one turn, a move or an undo, and most steps hold none. A held direction repeats, timed in
 * steps, so a replay of the same input gives the same run. A box that fills a hole leaves the
 * board, and an undo brings it back with the same id. Push-puzzle has no randomness, so a run
 * needs no seed.
 *
 * Plain on purpose: a step gives the same bits on every peer and every replay, and finishes in
 * the call. Nothing is allocated per step or per turn, but the one event a solve reports.
 */
import { EntityPool, Ring, TileMap } from "arcadekit/core";
import type * as Game from "arcadekit/game";
import { Schema } from "effect";

import { LevelSolved } from "./events";
import * as Level from "./level";
import type * as PuzzleContent from "./puzzle-content";

/**
 * A direction the player moves in, as a Schema: `up`, `down`, `left` or `right`.
 *
 * **When to use**
 *
 * To check a direction that comes from outside the step, such as a recorded input.
 *
 * **Example** (Checking a direction)
 *
 * ```ts
 * import { World } from "@arcadekit/push-puzzle";
 * import { Schema } from "effect";
 *
 * Schema.is(World.Direction)("up"); // => true
 * Schema.is(World.Direction)("north"); // => false
 * ```
 *
 * @category schemas
 */
export const Direction = Schema.Literals(["up", "down", "left", "right"]);

/**
 * One of the four directions: `"up"`, `"down"`, `"left"` or `"right"`. Up is toward row 0, the
 * top of the board.
 *
 * **When to use**
 *
 * To type a direction an input source or a test writes.
 *
 * **Example** (Turning around)
 *
 * ```ts
 * import type { World } from "@arcadekit/push-puzzle";
 *
 * const back: Record<World.Direction, World.Direction> = {
 *   up: "down",
 *   down: "up",
 *   left: "right",
 *   right: "left",
 * };
 * back.left; // => "right"
 * ```
 *
 * @category models
 */
export type Direction = typeof Direction.Type;

/**
 * One step's input, as a Schema: the direction held, the direction pressed during the step, and
 * whether undo was pressed.
 *
 * **When to use**
 *
 * As the simulation's `input`, and to check an input script read from a file.
 *
 * **Details**
 *
 * A press moves at once. Holding the direction pressed last moves again after 12 steps, then
 * every 6 steps; holding one that wasn't pressed in this run moves nothing. Undo takes back one
 * turn per press, and never repeats.
 *
 * **Example** (A step with nothing pressed)
 *
 * ```ts
 * import { World } from "@arcadekit/push-puzzle";
 * import { Schema } from "effect";
 *
 * Schema.is(World.Input)({ held: null, pressed: null, undo: false }); // => true
 * Schema.is(World.Input)({ held: "up", pressed: null }); // => false
 * ```
 *
 * @category schemas
 */
export const Input = Schema.Struct({
  /** The direction held down now, if any. Holding it repeats the move. */
  held: Schema.NullOr(Direction),
  /** The direction pressed during this step, if any. Starts a move right away. */
  pressed: Schema.NullOr(Direction),
  /** Whether undo was pressed during this step. Fires once per press, never repeats. */
  undo: Schema.Boolean,
});

/**
 * One step's input: what an input source gives the loop for each step.
 *
 * **When to use**
 *
 * To type an input source or a script of inputs, as a test or a replay writes one.
 *
 * **Example** (A script of taps)
 *
 * ```ts
 * import type { World } from "@arcadekit/push-puzzle";
 * import type * as Game from "arcadekit/game";
 *
 * const presses = ["right", "right"] as const;
 * const script: Game.StepInput<World.Input> = {
 *   read: (step) => ({ held: null, pressed: presses[step] ?? null, undo: false }),
 * };
 * script.read(1).pressed; // => "right"
 * script.read(2).pressed; // => null
 * ```
 *
 * @category models
 */
export type Input = typeof Input.Type;

/**
 * What a run starts from: the levels, which one to play, and how far undo goes back.
 *
 * **When to use**
 *
 * As what `engine.start`, `loop.start` or a scenario's `given` takes: a run is one attempt at one
 * level.
 *
 * **Example** (A run with a short undo)
 *
 * ```ts
 * import { PuzzleContent, World } from "@arcadekit/push-puzzle";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(PuzzleContent.PuzzleContent)({
 *   levels: [{ id: "corridor", name: "Corridor", rows: ["######", "#@ $.#", "######"] }],
 * });
 * const config: World.Config = { content, levelId: "corridor", historyCapacity: 64 };
 * World.make(config).history.capacity; // => 64
 * ```
 *
 * @category models
 */
export interface Config {
  readonly content: PuzzleContent.PuzzleContent;
  /** The level to play. Must be one of `content`'s levels: `make` throws otherwise. */
  readonly levelId: string;
  /**
   * How many turns undo can go back, a whole number of 1 or more: `make` throws otherwise.
   * Defaults to 2048; the oldest are dropped first.
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

/**
 * What a record of a run's `changes` says a turn did: a box filled a hole, or a turn was undone.
 *
 * **When to use**
 *
 * In a view, to read each record of the run's `changes` it hasn't taken yet with a ring reader.
 *
 * **Details**
 *
 * A record's `box` is the stable id of the box that filled a hole, and its `cell` the hole's
 * cell. An undo's record has -1 for both.
 *
 * **Example** (A box that filled a hole)
 *
 * ```ts
 * import { PuzzleContent, World } from "@arcadekit/push-puzzle";
 * import { Ring } from "arcadekit/core";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(PuzzleContent.PuzzleContent)({
 *   levels: [{ id: "hole", name: "Hole", rows: ["######", "#@$^.#", "#  $ #", "######"] }],
 * });
 * const puzzle = World.make({ content, levelId: "hole" });
 * const right = { held: "right", pressed: "right", undo: false } as const;
 * World.step(puzzle, right, { dt: 1 / 60, step: 0, report: () => {} });
 * const slot = Ring.slotOf(puzzle.changes, 0);
 * puzzle.changes.fields.kind[slot] === World.Change.holeFilled; // => true
 * [puzzle.changes.fields.box[slot], puzzle.changes.fields.cell[slot]]; // => [0, 9]
 * ```
 *
 * @category models
 */
export const Change = {
  /** A box fell into a hole and filled it: `box` is the box's id and `cell` the hole's cell. */
  holeFilled: 1,
  /** A turn was undone. Its `box` and `cell` are -1. */
  undone: 2,
} as const;

/**
 * One of the two kinds of change: `World.Change.holeFilled` or `undone`.
 *
 * **When to use**
 *
 * To type a change's kind read from the ring.
 *
 * **Example** (Naming a kind)
 *
 * ```ts
 * import { World } from "@arcadekit/push-puzzle";
 *
 * const kind: World.Change = World.Change.undone;
 * kind; // => 2
 * ```
 *
 * @category models
 */
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
 * How many records a run's `changes` holds. The engine's frame runs at most five steps
 * (`maxStepsPerFrame`) and a step holds at most one turn, so a view that looks on every frame
 * loses nothing.
 */
const CHANGES_CAPACITY = 8;

/**
 * A run's cue counters: running totals of the moments that make a sound.
 *
 * **When to use**
 *
 * In a sound view, which plays a sound for each counter that rose since its last frame.
 *
 * **Details**
 *
 * The step bumps them and never reads them, and undo leaves them alone and bumps `undos`, so
 * they only go up during a run. A replay's end state leaves them out.
 *
 * **Example** (A move, then a push that solves)
 *
 * ```ts
 * import { PuzzleContent, World } from "@arcadekit/push-puzzle";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(PuzzleContent.PuzzleContent)({
 *   levels: [{ id: "corridor", name: "Corridor", rows: ["######", "#@ $.#", "######"] }],
 * });
 * const puzzle = World.make({ content, levelId: "corridor" });
 * const right = { held: "right", pressed: "right", undo: false } as const;
 * World.step(puzzle, right, { dt: 1 / 60, step: 0, report: () => {} });
 * World.step(puzzle, right, { dt: 1 / 60, step: 1, report: () => {} });
 * puzzle.cues; // => { moves: 1, pushes: 1, holesFilled: 0, undos: 0, solved: 1 }
 * ```
 *
 * @category models
 */
export interface Cues {
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

/**
 * A run's state: the level's tile map, the boxes and the player on it, the counts the HUD shows,
 * the undo history, what the turns did for the views, and the cue counters.
 *
 * **When to use**
 *
 * To read a run in a view, a test or a replay check. Only `step` changes it.
 *
 * **Details**
 *
 * Each run has its own state object, so a view tells runs apart by identity. Cells are numbered
 * `row * cols + col`. A box keeps its stable id for the whole run: a box that fills a hole leaves
 * the pool, and an undo brings it back with the same id, so a view names a box by its id
 * (`EntityPool.idOf`, `EntityPool.indexOf`), never by its index in the pool.
 *
 * **Example** (A run at its start)
 *
 * ```ts
 * import { PuzzleContent, World } from "@arcadekit/push-puzzle";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(PuzzleContent.PuzzleContent)({
 *   levels: [{ id: "corridor", name: "Corridor", rows: ["######", "#@ $.#", "######"] }],
 * });
 * const puzzle: World.Puzzle = World.make({ content, levelId: "corridor" });
 * [puzzle.player, puzzle.boxes.count, puzzle.goalCount, puzzle.solved]; // => [7, 1, 1, false]
 * ```
 *
 * @category models
 */
export interface Puzzle {
  /**
   * The tile map: for each cell, its `Level.Tile` in the field `tile`, and 1 in `goal` where it
   * is a goal. Cells are indexed `row * cols + col`. A cell's tile changes only when a hole is
   * filled or reopened by undo.
   */
  readonly map: TileMap.TileMap<typeof Level.layout>;
  readonly goalCount: number;
  /**
   * Every box still on the board. Pool indices move when a box is removed (filling a hole),
   * so undo and the view name a box by its stable id (`idOf`, `indexOf`), never by index.
   */
  readonly boxes: EntityPool.Identified<typeof BOX_LAYOUT>;
  /** The player's cell. */
  player: number;
  /** Moves made, minus moves undone. */
  moves: number;
  /** Turns that changed the board, moves and undos alike. Only goes up, so the HUD sample can watch it. */
  turns: number;
  /** Set on the turn every goal gets a box. No further turns are taken. */
  solved: boolean;
  /** One record for each turn undo can take back, newest last. The rules pop it, so it is state. */
  readonly history: Ring.Ring<typeof HISTORY_LAYOUT>;
  /**
   * What a turn did that the board no longer shows after it: a box that filled a hole, which is
   * gone with it, and an undo. A ring the view alone reads: the rules push to it and never read
   * it back. Not part of the replay's end state.
   */
  readonly changes: Ring.Ring<typeof CHANGE_LAYOUT>;
  /** The pressed direction that is still held, and steps until it moves again. Timed in steps, so replays are exact. */
  readonly repeat: { direction: Direction | null; stepsLeft: number };
  /** Sound triggers, read by the presentation only. Not part of the replay's end state. */
  readonly cues: Cues;
}

/**
 * Starts a run on one level: its tile map, its boxes and its player as the level's text has
 * them, and an empty history.
 *
 * **When to use**
 *
 * As the simulation's `create`, which the loop calls on `start`. A test that steps a run by hand
 * calls it too.
 *
 * **Details**
 *
 * Boxes get the ids 0, 1, 2… in the level's reading order. It throws an `Error` that names the
 * level when `levelId` isn't one of the content's, and a `RangeError` when `historyCapacity`
 * isn't a whole number of 1 or more: decoded content only holds levels that can be played, so
 * either is the caller's mistake.
 *
 * **Example** (A run, and a level the content lacks)
 *
 * ```ts
 * import { PuzzleContent, World } from "@arcadekit/push-puzzle";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(PuzzleContent.PuzzleContent)({
 *   levels: [{ id: "corridor", name: "Corridor", rows: ["######", "#@ $.#", "######"] }],
 * });
 * World.boardText(World.make({ content, levelId: "corridor" })); // => ["######", "#@ $.#", "######"]
 *
 * let refused = "";
 * try {
 *   World.make({ content, levelId: "missing" });
 * } catch (error) {
 *   refused = String(error);
 * }
 * refused; // => 'Error: push-puzzle content has no level "missing"'
 * ```
 *
 * @category constructors
 */
export const make = ({ content, levelId, historyCapacity }: Config): Puzzle => {
  const level = content.levels.find((l) => l.id === levelId);
  if (level === undefined) {
    // Decoded content only holds levels that can be played, so this is the caller's mistake.
    throw new Error(`push-puzzle content has no level "${levelId}"`);
  }
  const turnsKept = historyCapacity ?? DEFAULT_HISTORY_CAPACITY;
  if (!Number.isInteger(turnsKept) || turnsKept < 1) {
    // `Ring.make` refuses it too, by a name the game never wrote.
    throw new RangeError(
      `push-puzzle's historyCapacity must be a whole number of 1 or more, got ${turnsKept}`
    );
  }
  const parsed = Level.parse(level.rows);
  // The schema rejects a level without exactly one player.
  const player = parsed.players[0]!;
  // Boxes get ids 0, 1, 2… in level reading order. None is ever added after this, so an id
  // freed by filling a hole stays free until undo brings that box back.
  const boxes = EntityPool.makeIdentified(parsed.boxes.length, BOX_LAYOUT);
  for (const cell of parsed.boxes) {
    boxes.fields.cell[EntityPool.add(boxes)] = cell;
  }
  return {
    map: parsed.map,
    goalCount: parsed.goalCount,
    boxes,
    player,
    moves: 0,
    turns: 0,
    solved: false,
    history: Ring.make(turnsKept, HISTORY_LAYOUT),
    changes: Ring.make(CHANGES_CAPACITY, CHANGE_LAYOUT),
    repeat: { direction: null, stepsLeft: 0 },
    cues: { moves: 0, pushes: 0, holesFilled: 0, undos: 0, solved: 0 },
  };
};

/**
 * Advances a run by one step: takes at most one turn, a move or an undo, and reports
 * `LevelSolved` on the move that puts a box on the last goal.
 *
 * **When to use**
 *
 * As the simulation's `step`, which the loop calls once per step. A test that steps a run by hand
 * calls it with a context of its own.
 *
 * **Details**
 *
 * The step's `dt` is unused: a held direction is timed in steps. A move into a wall, into a box
 * with a wall, a hole or another box behind it, or into a hole moves nothing and is no turn; an
 * undo with no history left is none either. Once the level is solved, no step takes a turn.
 *
 * **Example** (Two presses that solve a level)
 *
 * ```ts
 * import { PuzzleContent, World } from "@arcadekit/push-puzzle";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(PuzzleContent.PuzzleContent)({
 *   levels: [{ id: "corridor", name: "Corridor", rows: ["######", "#@ $.#", "######"] }],
 * });
 * const puzzle = World.make({ content, levelId: "corridor" });
 * const reported: unknown[] = [];
 * const right = { held: "right", pressed: "right", undo: false } as const;
 * for (const step of [0, 1]) {
 *   World.step(puzzle, right, { dt: 1 / 60, step, report: (event) => reported.push(event) });
 * }
 * World.boardText(puzzle); // => ["######", "#  @*#", "######"]
 * [puzzle.moves, puzzle.solved, reported.length]; // => [2, true, 1]
 * ```
 *
 * @category mutations
 */
export const step = (
  self: Puzzle,
  input: Input,
  { report }: Game.StepContext<LevelSolved>
): void => {
  if (self.solved) {
    return;
  }
  const { repeat } = self;
  if (input.undo) {
    undoTurn(self);
    // A direction held through an undo doesn't move until it's pressed again.
    repeat.direction = null;
    return;
  }
  if (input.pressed !== null) {
    repeat.direction = input.pressed;
    repeat.stepsLeft = REPEAT_DELAY_STEPS;
    takeMove(self, input.pressed, report);
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
    takeMove(self, input.held, report);
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
  up: TileMap.Side.north,
  down: TileMap.Side.south,
  left: TileMap.Side.west,
  right: TileMap.Side.east,
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
  const target = TileMap.neighbor(map, puzzle.player, side);
  if (target === -1 || tile[target] !== Level.Tile.floor) {
    return false;
  }
  const box = boxIndexAt(puzzle, target);
  let boxId = -1;
  let filledHole = 0;
  if (box !== -1) {
    const beyond = TileMap.neighbor(map, target, side);
    if (beyond === -1 || boxIndexAt(puzzle, beyond) !== -1) {
      return false;
    }
    const under = tile[beyond];
    if (under !== Level.Tile.floor && under !== Level.Tile.hole) {
      return false;
    }
    boxId = EntityPool.idOf(puzzle.boxes, box);
    if (under === Level.Tile.hole) {
      // The box fills the hole: both are gone, and the cell is floor from now on.
      tile[beyond] = Level.Tile.floor;
      EntityPool.remove(puzzle.boxes, box);
      filledHole = 1;
      const { changes } = puzzle;
      const change = Ring.push(changes);
      changes.fields.kind[change] = Change.holeFilled;
      changes.fields.box[change] = boxId;
      changes.fields.cell[change] = beyond;
    } else {
      puzzle.boxes.fields.cell[box] = beyond;
    }
  }
  const { history } = puzzle;
  const record = Ring.push(history);
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
  const record = Ring.pop(history);
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
      puzzle.map.fields.tile[boxTo] = Level.Tile.hole;
      boxes.fields.cell[EntityPool.addWithId(boxes, boxId)] = boxFrom;
    } else {
      boxes.fields.cell[EntityPool.indexOf(boxes, boxId)] = boxFrom;
    }
  }
  puzzle.player = playerFrom;
  puzzle.moves -= 1;
  puzzle.turns += 1;
  // The cues stay as they are: undo is a sound of its own, never a move counted back down.
  puzzle.cues.undos += 1;
  const change = Ring.push(changes);
  changes.fields.kind[change] = Change.undone;
  changes.fields.box[change] = -1;
  changes.fields.cell[change] = -1;
};

/**
 * The stable id of the box at column `col` and row `row`, or -1 where there is none.
 *
 * **When to use**
 *
 * In a test or a replay check, to tell boxes apart: board text can't.
 *
 * **Example** (The one box of a level)
 *
 * ```ts
 * import { PuzzleContent, World } from "@arcadekit/push-puzzle";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(PuzzleContent.PuzzleContent)({
 *   levels: [{ id: "corridor", name: "Corridor", rows: ["######", "#@ $.#", "######"] }],
 * });
 * const puzzle = World.make({ content, levelId: "corridor" });
 * World.boxIdAt(puzzle, 3, 1); // => 0
 * World.boxIdAt(puzzle, 2, 1); // => -1
 * ```
 *
 * @category getters
 */
export const boxIdAt = (self: Puzzle, col: number, row: number): number => {
  const i = boxIndexAt(self, TileMap.cellAt(self.map, col, row));
  return i === -1 ? -1 : EntityPool.idOf(self.boxes, i);
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

/**
 * What the `Hud` sample carries: the moves made, and the goals that have no box on them yet.
 *
 * **When to use**
 *
 * As the simulation's sample `read`, which the loop calls at a run's start and after each turn.
 *
 * **Example** (A run's first HUD)
 *
 * ```ts
 * import { PuzzleContent, World } from "@arcadekit/push-puzzle";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(PuzzleContent.PuzzleContent)({
 *   levels: [{ id: "corridor", name: "Corridor", rows: ["######", "#@ $.#", "######"] }],
 * });
 * World.hudSample(World.make({ content, levelId: "corridor" })); // => { moves: 0, boxesLeft: 1 }
 * ```
 *
 * @category getters
 */
export const hudSample = (
  self: Puzzle
): { readonly moves: number; readonly boxesLeft: number } => ({
  moves: self.moves,
  boxesLeft: boxesLeft(self),
});

/**
 * The board as level text, one string per row, with trailing spaces trimmed.
 *
 * **When to use**
 *
 * In a test, a replay check or a debugger, to read a run as a picture.
 *
 * **Details**
 *
 * It allocates, so no step or frame calls it. A filled hole reads as floor, and void as a space.
 *
 * **Example** (A push onto the goal)
 *
 * ```ts
 * import { PuzzleContent, World } from "@arcadekit/push-puzzle";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(PuzzleContent.PuzzleContent)({
 *   levels: [{ id: "push", name: "Push", rows: ["#####", "#@$.#", "#####"] }],
 * });
 * const puzzle = World.make({ content, levelId: "push" });
 * const right = { held: "right", pressed: "right", undo: false } as const;
 * World.step(puzzle, right, { dt: 1 / 60, step: 0, report: () => {} });
 * World.boardText(puzzle); // => ["#####", "# @*#", "#####"]
 * ```
 *
 * @category getters
 */
export const boardText = (self: Puzzle): string[] => {
  const lines: string[] = [];
  const { map } = self;
  for (let row = 0; row < map.rows; row++) {
    let line = "";
    for (let col = 0; col < map.cols; col++) {
      line += cellChar(self, TileMap.cellAt(map, col, row));
    }
    lines.push(line.trimEnd());
  }
  return lines;
};

const cellChar = (puzzle: Puzzle, cell: number): string => {
  switch (puzzle.map.fields.tile[cell]) {
    case Level.Tile.wall: {
      return "#";
    }
    case Level.Tile.hole: {
      return "^";
    }
    case Level.Tile.floor: {
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
