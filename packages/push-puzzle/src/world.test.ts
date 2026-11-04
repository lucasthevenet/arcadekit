import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PuzzleContent, boardText, boxIdAt, createPuzzle, step } from "./index";
import type {
  Direction,
  Puzzle,
  PushPuzzleConfig,
  PushPuzzleEvent,
} from "./index";

// Tests drive a run the way the runtime does: one input per step.
// Boards are written and read back in level text, so each case reads like a picture.

const DT = 1 / 60;
const NOTHING = { held: null, pressed: null, undo: false } as const;

const start = (
  rows: readonly string[],
  options: Partial<PushPuzzleConfig> = {}
): Puzzle => {
  const content = Schema.decodeUnknownSync(PuzzleContent)({
    levels: [{ id: "test", name: "Test", rows }],
  });
  return createPuzzle({ content, levelId: "test", ...options }, 0);
};

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

describe("replay", () => {
  /** The recorded box ids by cell index (row * 8 + column); every other cell has none (-1). */
  const RECORDED_BOX_IDS: Readonly<Record<number, number>> = { 18: 1, 19: 2 };
  const LEVEL = ["########", "#@ $ ^ #", "# $$ . #", "#  ..  #", "########"];

  /** A scripted run with taps, holds and undos, mixed with idle steps. */
  const replay = () => {
    const puzzle = start(LEVEL);
    const script = "RRDLLURDDRUULRRDDR";
    for (const [i, char] of [...script].entries()) {
      const direction =
        DIRECTION_BY_CHAR[char as keyof typeof DIRECTION_BY_CHAR];
      const held = i % 4 === 0 ? 20 : 1;
      for (let s = 0; s < held; s++) {
        step(
          puzzle,
          { held: direction, pressed: s === 0 ? direction : null, undo: false },
          DT
        );
      }
      step(puzzle, NOTHING, DT);
      if (i % 5 === 4) {
        undo(puzzle);
      }
    }
    return {
      board: boardText(puzzle),
      // Board text can't tell boxes apart; their stable ids can.
      boxIds: boardText(puzzle).flatMap((line, row) =>
        [...line].map((_, col) => boxIdAt(puzzle, col, row))
      ),
      moves: puzzle.moves,
      events: [...puzzle.events.drain()],
    };
  };

  it("ends in the recorded state", () => {
    // Recorded from this script. A change here changes how a run plays.
    expect(replay()).toStrictEqual({
      board: ["########", "#      #", "# $$ . #", "#  ..@ #", "########"],
      boxIds: Array.from({ length: 40 }, (_, i) => RECORDED_BOX_IDS[i] ?? -1),
      moves: 16,
      events: [],
    });
  });

  it("gives an identical state for the same level and input script", () => {
    const a = replay();
    expect(a.moves).toBeGreaterThan(5);
    expect(replay()).toStrictEqual(a);
  });
});
