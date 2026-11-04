import { GameLoop } from "@gamekit/runtime";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  PuzzleContent,
  boardText,
  boxIdAt,
  createPuzzle,
  pushPuzzleSimulation,
  step,
} from "./index";
import type {
  Direction,
  Puzzle,
  PushPuzzleConfig,
  PushPuzzleEvent,
  PushPuzzleInput,
} from "./index";

// Tests drive a run the way the runtime does: one input per step.
// Boards are written and read back in level text, so each case reads like a picture.

const DT = 1 / 60;
const NOTHING = { held: null, pressed: null, undo: false } as const;

/** A config for a one-level game whose level is `rows`. */
const configFor = (
  rows: readonly string[],
  options: Partial<PushPuzzleConfig> = {}
): PushPuzzleConfig => ({
  content: Schema.decodeUnknownSync(PuzzleContent)({
    levels: [{ id: "test", name: "Test", rows }],
  }),
  levelId: "test",
  ...options,
});

const start = (
  rows: readonly string[],
  options: Partial<PushPuzzleConfig> = {}
): Puzzle => createPuzzle(configFor(rows, options), 0);

/** One tap: a step with the direction pressed, then a step with nothing held. */
const tap = (puzzle: Puzzle, direction: Direction) => {
  step(puzzle, { held: direction, pressed: direction, undo: false }, DT);
  step(puzzle, NOTHING, DT);
};

const taps = (puzzle: Puzzle, directions: string) => {
  for (const char of directions) {
    tap(puzzle, DIRECTION_BY_CHAR[char as keyof typeof DIRECTION_BY_CHAR]);
  }
};

const DIRECTION_BY_CHAR = {
  U: "up",
  D: "down",
  L: "left",
  R: "right",
} as const satisfies Record<string, Direction>;

const undo = (puzzle: Puzzle) => {
  step(puzzle, { held: null, pressed: null, undo: true }, DT);
  step(puzzle, NOTHING, DT);
};

describe("moving", () => {
  it("moves the player one cell per tap", () => {
    const puzzle = start(["#####", "#@  #", "#  .#", "#  $#", "#####"]);
    taps(puzzle, "RRD");
    expect(boardText(puzzle)).toStrictEqual([
      "#####",
      "#   #",
      "#  +#",
      "#  $#",
      "#####",
    ]);
    expect(puzzle.moves).toBe(3);
  });

  it("does nothing when walking into a wall", () => {
    const puzzle = start(["####", "#@.#", "# $#", "####"]);
    taps(puzzle, "UL");
    expect(boardText(puzzle)).toStrictEqual(["####", "#@.#", "# $#", "####"]);
    expect(puzzle.moves).toBe(0);
  });

  it("counts every turn that changed the board, undos included, for the HUD sample", () => {
    const puzzle = start(["#####", "#@  #", "#  .#", "#  $#", "#####"]);
    // Two moves, a move into the wall (no turn), two undos, and an undo with nothing left (no turn).
    taps(puzzle, "RRU");
    undo(puzzle);
    undo(puzzle);
    undo(puzzle);
    expect(puzzle.moves).toBe(0);
    expect(puzzle.turns).toBe(4);
  });
});

describe("pushing", () => {
  it("pushes a box one cell when the cell behind it is free", () => {
    const puzzle = start(["######", "#@$ .#", "######"]);
    taps(puzzle, "R");
    expect(boardText(puzzle)).toStrictEqual(["######", "# @$.#", "######"]);
    taps(puzzle, "R");
    expect(boardText(puzzle)).toStrictEqual(["######", "#  @*#", "######"]);
  });

  it("does nothing when a wall or another box is behind the box", () => {
    const puzzle = start(["######", "#@$$.#", "#   .#", "######"]);
    taps(puzzle, "R");
    expect(boardText(puzzle)).toStrictEqual([
      "######",
      "#@$$.#",
      "#   .#",
      "######",
    ]);
    // Down, right, then up: the box above would go into the wall. Blocked.
    taps(puzzle, "DRU");
    expect(boardText(puzzle)).toStrictEqual([
      "######",
      "# $$.#",
      "# @ .#",
      "######",
    ]);
    expect(puzzle.moves).toBe(2);
  });
});

describe("holes", () => {
  it("blocks walking into an unfilled hole", () => {
    const puzzle = start(["#####", "#@^.#", "#  $#", "#####"]);
    taps(puzzle, "R");
    expect(boardText(puzzle)[1]).toBe("#@^.#");
    expect(puzzle.moves).toBe(0);
  });

  it("fills a hole with a pushed box, which can then be walked over", () => {
    const puzzle = start(["######", "#@$^ #", "#  $.#", "######"]);
    taps(puzzle, "R");
    expect(boardText(puzzle)).toStrictEqual([
      "######",
      "# @  #",
      "#  $.#",
      "######",
    ]);
    taps(puzzle, "RR");
    expect(boardText(puzzle)[1]).toBe("#   @#");
    expect(puzzle.moves).toBe(3);
  });
});

describe("undo", () => {
  const LEVEL = ["#######", "#@$^ .#", "#  $  #", "#######"];

  it("takes back a move", () => {
    const puzzle = start(LEVEL);
    taps(puzzle, "D");
    undo(puzzle);
    expect(boardText(puzzle)).toStrictEqual(LEVEL);
    expect(puzzle.moves).toBe(0);
  });

  it("takes back a push", () => {
    const puzzle = start(LEVEL);
    taps(puzzle, "DRR");
    expect(boardText(puzzle)[2]).toBe("#  @$ #");
    undo(puzzle);
    expect(boardText(puzzle)[2]).toBe("# @$  #");
    expect(puzzle.moves).toBe(2);
  });

  it("brings back a box that filled a hole, with the same id, and reopens the hole", () => {
    const puzzle = start(LEVEL);
    const id = boxIdAt(puzzle, 2, 1);
    taps(puzzle, "R");
    expect(boardText(puzzle)[1]).toBe("# @  .#");
    undo(puzzle);
    expect(boardText(puzzle)).toStrictEqual(LEVEL);
    expect(boxIdAt(puzzle, 2, 1)).toBe(id);
  });

  it("goes back many turns, to the start of the level", () => {
    const puzzle = start(LEVEL);
    taps(puzzle, "RDRRUR");
    for (let i = 0; i < 6; i++) {
      undo(puzzle);
    }
    expect(boardText(puzzle)).toStrictEqual(LEVEL);
    expect(puzzle.moves).toBe(0);
  });

  it("does nothing with no history left", () => {
    const puzzle = start(LEVEL);
    undo(puzzle);
    taps(puzzle, "D");
    undo(puzzle);
    undo(puzzle);
    expect(boardText(puzzle)).toStrictEqual(LEVEL);
    expect(puzzle.moves).toBe(0);
  });

  it("drops the oldest turn when the history is full", () => {
    const puzzle = start(LEVEL, { historyCapacity: 3 });
    taps(puzzle, "DRRR");
    for (let i = 0; i < 5; i++) {
      undo(puzzle);
    }
    // Only the last three moves came back; the first (down) was forgotten.
    expect(boardText(puzzle)).toStrictEqual([
      "#######",
      "# $^ .#",
      "#@ $  #",
      "#######",
    ]);
    expect(puzzle.moves).toBe(1);
  });

  it("fires once per press, even while held", () => {
    const puzzle = start(LEVEL);
    taps(puzzle, "DR");
    for (let i = 0; i < 40; i++) {
      step(puzzle, { held: null, pressed: null, undo: i === 0 }, DT);
    }
    expect(puzzle.moves).toBe(1);
  });
});

/** Holds right for `steps` steps (pressed on the first) and returns the step numbers that moved. */
const holdRight = (puzzle: Puzzle, steps: number) => {
  const movedAt: number[] = [];
  for (let i = 0; i < steps; i++) {
    const before = puzzle.moves;
    step(
      puzzle,
      { held: "right", pressed: i === 0 ? "right" : null, undo: false },
      DT
    );
    if (puzzle.moves > before) {
      movedAt.push(i);
    }
  }
  return movedAt;
};

describe("holding a direction", () => {
  const CORRIDOR = [
    "##############################",
    "#@                         $.#",
    "##############################",
  ];

  it("moves on the press, again after 12 steps, then every 6 steps", () => {
    expect(holdRight(start(CORRIDOR), 31)).toStrictEqual([0, 12, 18, 24, 30]);
  });

  it("starts the delay over after a release", () => {
    const puzzle = start(CORRIDOR);
    holdRight(puzzle, 15);
    step(puzzle, NOTHING, DT);
    expect(holdRight(puzzle, 13)).toStrictEqual([0, 12]);
    expect(puzzle.moves).toBe(4);
  });

  it("doesn't repeat a direction that was never pressed in this run", () => {
    const puzzle = start(CORRIDOR);
    for (let i = 0; i < 40; i++) {
      step(puzzle, { held: "right", pressed: null, undo: false }, DT);
    }
    expect(puzzle.moves).toBe(0);
  });
});

const drain = (puzzle: Puzzle): PushPuzzleEvent[] => [...puzzle.events.drain()];

describe("solving", () => {
  const LEVEL = ["#######", "#@$  .#", "#######"];

  it("reports levelSolved once, with the move count, when every goal has a box", () => {
    const puzzle = start(LEVEL);
    taps(puzzle, "R");
    undo(puzzle);
    taps(puzzle, "RR");
    expect(drain(puzzle)).toStrictEqual([]);
    taps(puzzle, "R");
    expect(boardText(puzzle)[1]).toBe("#   @*#");
    expect(puzzle.solved).toBe(true);
    expect(drain(puzzle)).toStrictEqual([{ type: "levelSolved", moves: 3 }]);
  });

  it("ignores moves and undo once solved", () => {
    const puzzle = start(LEVEL);
    taps(puzzle, "RRR");
    drain(puzzle);
    taps(puzzle, "LL");
    undo(puzzle);
    expect(boardText(puzzle)[1]).toBe("#   @*#");
    expect(puzzle.moves).toBe(3);
    expect(drain(puzzle)).toStrictEqual([]);
  });
});

/**
 * The replay's input, one entry per step: taps, holds and undos, mixed with idle steps. Each
 * move is held for 20 steps (every 4th) or 1, with the direction pressed on the first, then a
 * step with nothing held; every 5th move is followed by an undo and a step with nothing.
 */
const REPLAY_INPUTS: readonly PushPuzzleInput[] = [
  ..."RRDLLURDDRUULRRDDR",
].flatMap((char, i) => {
  const direction = DIRECTION_BY_CHAR[char as keyof typeof DIRECTION_BY_CHAR];
  const held = i % 4 === 0 ? 20 : 1;
  const steps: PushPuzzleInput[] = Array.from({ length: held }, (_, s) => ({
    held: direction,
    pressed: s === 0 ? direction : null,
    undo: false,
  }));
  steps.push(NOTHING);
  if (i % 5 === 4) {
    steps.push({ held: null, pressed: null, undo: true }, NOTHING);
  }
  return steps;
});

describe("replay", () => {
  /** The recorded box ids by cell index (row * 8 + column); every other cell has none (-1). */
  const RECORDED_BOX_IDS: Readonly<Record<number, number>> = { 18: 1, 19: 2 };
  const LEVEL = ["########", "#@ $ ^ #", "# $$ . #", "#  ..  #", "########"];

  /**
   * Plays the scripted input through @gamekit/runtime's GameLoop, one step per frame, the step
   * order the demo runs. Collects the events and counts the HUD samples the run reported.
   */
  const replay = () => {
    const loop = new GameLoop(pushPuzzleSimulation);
    const events: PushPuzzleEvent[] = [];
    let samples = 0;
    loop.subscribe((event) => {
      if (event.type === "hud") {
        samples += 1;
      } else {
        events.push(event);
      }
    });
    loop.start(configFor(LEVEL), 0, 0);
    const script = { read: (n: number) => REPLAY_INPUTS[n]! };
    for (let i = 0; i < REPLAY_INPUTS.length; i++) {
      loop.frame(script, { steps: 1 }, (i * 1000) / 60);
    }
    const puzzle = loop.state!;
    return {
      board: boardText(puzzle),
      // Board text can't tell boxes apart; their stable ids can.
      boxIds: boardText(puzzle).flatMap((line, row) =>
        [...line].map((_, col) => boxIdAt(puzzle, col, row))
      ),
      moves: puzzle.moves,
      events,
      turns: puzzle.turns,
      samples,
    };
  };

  it("ends in the recorded state", () => {
    // Recorded from this script before the replay ran through GameLoop. A change here changes
    // how a run plays.
    expect(replay()).toStrictEqual({
      board: ["########", "#      #", "# $$ . #", "#  ..@ #", "########"],
      boxIds: Array.from({ length: 40 }, (_, i) => RECORDED_BOX_IDS[i] ?? -1),
      moves: 16,
      events: [],
      turns: 22,
      // The HUD sample comes once at the start, then once per turn.
      samples: 22 + 1,
    });
  });

  it("gives an identical state for the same level and input script", () => {
    const a = replay();
    expect(a.moves).toBeGreaterThan(5);
    expect(replay()).toStrictEqual(a);
  });
});
