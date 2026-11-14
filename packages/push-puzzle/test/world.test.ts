import { EntityPool, Ring } from "arcadekit/core";
import * as Game from "arcadekit/game";
import * as Scenario from "arcadekit/game/scenario";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { Hud, LevelSolved } from "../src/events";
import * as PuzzleContent from "../src/puzzle-content";
import { PushPuzzle } from "../src/simulation";
import * as World from "../src/world";

// Tests drive a run the way the loop does: one input per step.
// Boards are written and read back in level text, so each case reads like a picture.

/** A step's context for a test that calls `step` itself: its events go nowhere. */
const STEP = { dt: 1 / 60, step: 0, report: () => {} };
const NOTHING = { held: null, pressed: null, undo: false } as const;

/** A config for a one-level game whose level is `rows`. */
const configFor = (
  rows: readonly string[],
  options: Partial<World.Config> = {}
): World.Config => ({
  content: Schema.decodeUnknownSync(PuzzleContent.PuzzleContent)({
    levels: [{ id: "test", name: "Test", rows }],
  }),
  levelId: "test",
  ...options,
});

const start = (
  rows: readonly string[],
  options: Partial<World.Config> = {}
): World.Puzzle => World.make(configFor(rows, options));

/** One tap: a step with the direction pressed, then a step with nothing held. */
const tap = (puzzle: World.Puzzle, direction: World.Direction) => {
  World.step(
    puzzle,
    { held: direction, pressed: direction, undo: false },
    STEP
  );
  World.step(puzzle, NOTHING, STEP);
};

const taps = (puzzle: World.Puzzle, directions: string) => {
  for (const char of directions) {
    tap(puzzle, DIRECTION_BY_CHAR[char as keyof typeof DIRECTION_BY_CHAR]);
  }
};

const DIRECTION_BY_CHAR = {
  U: "up",
  D: "down",
  L: "left",
  R: "right",
} as const satisfies Record<string, World.Direction>;

const undo = (puzzle: World.Puzzle) => {
  World.step(puzzle, { held: null, pressed: null, undo: true }, STEP);
  World.step(puzzle, NOTHING, STEP);
};

describe("moving", () => {
  it("moves the player one cell per tap", () => {
    const puzzle = start(["#####", "#@  #", "#  .#", "#  $#", "#####"]);
    taps(puzzle, "RRD");
    expect(World.boardText(puzzle)).toStrictEqual([
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
    expect(World.boardText(puzzle)).toStrictEqual([
      "####",
      "#@.#",
      "# $#",
      "####",
    ]);
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
    expect(World.boardText(puzzle)).toStrictEqual([
      "######",
      "# @$.#",
      "######",
    ]);
    taps(puzzle, "R");
    expect(World.boardText(puzzle)).toStrictEqual([
      "######",
      "#  @*#",
      "######",
    ]);
  });

  it("does nothing when a wall or another box is behind the box", () => {
    const puzzle = start(["######", "#@$$.#", "#   .#", "######"]);
    taps(puzzle, "R");
    expect(World.boardText(puzzle)).toStrictEqual([
      "######",
      "#@$$.#",
      "#   .#",
      "######",
    ]);
    // Down, right, then up: the box above would go into the wall. Blocked.
    taps(puzzle, "DRU");
    expect(World.boardText(puzzle)).toStrictEqual([
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
    expect(World.boardText(puzzle)[1]).toBe("#@^.#");
    expect(puzzle.moves).toBe(0);
  });

  it("fills a hole with a pushed box, which can then be walked over", () => {
    const puzzle = start(["######", "#@$^ #", "#  $.#", "######"]);
    taps(puzzle, "R");
    expect(World.boardText(puzzle)).toStrictEqual([
      "######",
      "# @  #",
      "#  $.#",
      "######",
    ]);
    taps(puzzle, "RR");
    expect(World.boardText(puzzle)[1]).toBe("#   @#");
    expect(puzzle.moves).toBe(3);
  });
});

describe("undo", () => {
  const LEVEL = ["#######", "#@$^ .#", "#  $  #", "#######"];

  it("takes back a move", () => {
    const puzzle = start(LEVEL);
    taps(puzzle, "D");
    undo(puzzle);
    expect(World.boardText(puzzle)).toStrictEqual(LEVEL);
    expect(puzzle.moves).toBe(0);
  });

  it("takes back a push", () => {
    const puzzle = start(LEVEL);
    taps(puzzle, "DRR");
    expect(World.boardText(puzzle)[2]).toBe("#  @$ #");
    undo(puzzle);
    expect(World.boardText(puzzle)[2]).toBe("# @$  #");
    expect(puzzle.moves).toBe(2);
  });

  it("brings back a box that filled a hole, with the same id, and reopens the hole", () => {
    const puzzle = start(LEVEL);
    const id = World.boxIdAt(puzzle, 2, 1);
    taps(puzzle, "R");
    expect(World.boardText(puzzle)[1]).toBe("# @  .#");
    undo(puzzle);
    expect(World.boardText(puzzle)).toStrictEqual(LEVEL);
    expect(World.boxIdAt(puzzle, 2, 1)).toBe(id);
  });

  it("goes back many turns, to the start of the level", () => {
    const puzzle = start(LEVEL);
    taps(puzzle, "RDRRUR");
    for (let i = 0; i < 6; i++) {
      undo(puzzle);
    }
    expect(World.boardText(puzzle)).toStrictEqual(LEVEL);
    expect(puzzle.moves).toBe(0);
  });

  it("does nothing with no history left", () => {
    const puzzle = start(LEVEL);
    undo(puzzle);
    taps(puzzle, "D");
    undo(puzzle);
    undo(puzzle);
    expect(World.boardText(puzzle)).toStrictEqual(LEVEL);
    expect(puzzle.moves).toBe(0);
  });

  it("drops the oldest turn when the history is full", () => {
    const puzzle = start(LEVEL, { historyCapacity: 3 });
    taps(puzzle, "DRRR");
    for (let i = 0; i < 5; i++) {
      undo(puzzle);
    }
    // Only the last three moves came back; the first (down) was forgotten.
    expect(World.boardText(puzzle)).toStrictEqual([
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
      World.step(puzzle, { held: null, pressed: null, undo: i === 0 }, STEP);
    }
    expect(puzzle.moves).toBe(1);
  });
});

/** Holds right for `steps` steps (pressed on the first) and returns the step numbers that moved. */
const holdRight = (puzzle: World.Puzzle, steps: number) => {
  const movedAt: number[] = [];
  for (let i = 0; i < steps; i++) {
    const before = puzzle.moves;
    World.step(
      puzzle,
      { held: "right", pressed: i === 0 ? "right" : null, undo: false },
      STEP
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
    World.step(puzzle, NOTHING, STEP);
    expect(holdRight(puzzle, 13)).toStrictEqual([0, 12]);
    expect(puzzle.moves).toBe(4);
  });

  it("doesn't repeat a direction that was never pressed in this run", () => {
    const puzzle = start(CORRIDOR);
    for (let i = 0; i < 40; i++) {
      World.step(puzzle, { held: "right", pressed: null, undo: false }, STEP);
    }
    expect(puzzle.moves).toBe(0);
  });
});

// What the run reports is told as scenarios: given a level, after these presses, it reported this.
const scenario = Scenario.make(PushPuzzle);

/** One tap, as a scenario's steps. */
const press = (direction: World.Direction) => [
  Scenario.step({ held: direction, pressed: direction, undo: false }),
  Scenario.step(NOTHING),
];
const UNDO = [
  Scenario.step({ held: null, pressed: null, undo: true }),
  Scenario.step(NOTHING),
];

describe("solving", () => {
  const LEVEL = ["#######", "#@$  .#", "#######"];

  it("reports LevelSolved once, with the move count, when every goal has a box", () => {
    scenario(
      Scenario.given(configFor(LEVEL)),
      press("right"),
      UNDO,
      press("right"),
      press("right"),
      Scenario.reported(),
      press("right"),
      Scenario.reported(new LevelSolved({ moves: 3 })),
      Scenario.sampled(new Hud({ moves: 3, boxesLeft: 0 })),
      Scenario.state((puzzle) => {
        expect(World.boardText(puzzle)[1]).toBe("#   @*#");
        expect(puzzle.solved).toBe(true);
      })
    );
  });

  it("ignores moves and undo once solved", () => {
    scenario(
      Scenario.given(configFor(LEVEL)),
      press("right"),
      press("right"),
      press("right"),
      Scenario.reported(new LevelSolved({ moves: 3 })),
      press("left"),
      press("left"),
      UNDO,
      Scenario.reported(),
      Scenario.state((puzzle) => {
        expect(World.boardText(puzzle)[1]).toBe("#   @*#");
        expect(puzzle.moves).toBe(3);
      })
    );
  });
});

describe("cue counters", () => {
  const ZERO = { moves: 0, pushes: 0, holesFilled: 0, undos: 0, solved: 0 };

  it("start at zero", () => {
    expect(start(["####", "#@.#", "# $#", "####"]).cues).toStrictEqual(ZERO);
  });

  it("count a move, a push and a box into a hole", () => {
    const puzzle = start(["#######", "#@$^ .#", "#  $  #", "#######"]);
    taps(puzzle, "D");
    expect(puzzle.cues).toStrictEqual({ ...ZERO, moves: 1 });
    taps(puzzle, "RR");
    expect(puzzle.cues).toStrictEqual({ ...ZERO, moves: 2, pushes: 1 });
    // Left, up, then right pushes the top box into the hole.
    taps(puzzle, "LLUR");
    expect(World.boardText(puzzle)[1]).toBe("# @  .#");
    expect(puzzle.cues).toStrictEqual({
      ...ZERO,
      moves: 5,
      pushes: 2,
      holesFilled: 1,
    });
  });

  it("don't count a blocked move or an undo with no history left", () => {
    const puzzle = start(["######", "#@$$.#", "######"]);
    // Up into a wall, then right into two boxes in a row.
    taps(puzzle, "UR");
    undo(puzzle);
    expect(puzzle.cues).toStrictEqual(ZERO);
  });

  it("count an undo, and undo counts nothing down", () => {
    const puzzle = start(["######", "#@$^ #", "#  $.#", "######"]);
    taps(puzzle, "DUR");
    const before = { ...puzzle.cues };
    undo(puzzle);
    undo(puzzle);
    undo(puzzle);
    expect(World.boardText(puzzle)[1]).toBe("#@$^ #");
    expect(puzzle.cues).toStrictEqual({ ...before, undos: 3 });
    expect(before).toStrictEqual({
      ...ZERO,
      moves: 2,
      pushes: 1,
      holesFilled: 1,
    });
  });

  it("count the solve once", () => {
    const puzzle = start(["#######", "#@$  .#", "#######"]);
    taps(puzzle, "RRR");
    taps(puzzle, "LL");
    expect(puzzle.cues).toStrictEqual({ ...ZERO, pushes: 3, solved: 1 });
  });
});

/** Every record `changes` holds, oldest first, as [kind, box, cell]. */
const changesOf = (puzzle: World.Puzzle): number[][] => {
  const { changes } = puzzle;
  const records: number[][] = [];
  for (let n = changes.written - changes.length; n < changes.written; n++) {
    const i = Ring.slotOf(changes, n);
    records.push([
      changes.fields.kind[i]!,
      changes.fields.box[i]!,
      changes.fields.cell[i]!,
    ]);
  }
  return records;
};

describe("changes", () => {
  // The second box, id 1, is the one beside the hole, at column 3 of row 2: cell 2 * 7 + 3.
  const LEVEL = ["#######", "#  $ .#", "#@$^  #", "#     #", "#######"];
  const HOLE = 17;

  it("start with no record", () => {
    const { changes } = start(LEVEL);
    expect([changes.written, changes.length]).toStrictEqual([0, 0]);
  });

  it("record a box that filled a hole, with its id and the hole's cell", () => {
    const puzzle = start(LEVEL);
    const id = World.boxIdAt(puzzle, 2, 2);
    taps(puzzle, "R");
    // The box is in no pool and the hole on no tile: the record is what is left of the fall.
    expect(World.boardText(puzzle)[2]).toBe("# @   #");
    expect(World.boxIdAt(puzzle, 3, 2)).toBe(-1);
    expect([id, changesOf(puzzle)]).toStrictEqual([
      1,
      [[World.Change.holeFilled, 1, HOLE]],
    ]);
  });

  it("name the box that fell by its id, which its pool index no longer is once a box has fallen", () => {
    // Two boxes, each beside a hole: cells 1 * 8 + 3 and 2 * 8 + 3.
    const puzzle = start([
      "########",
      "#@$^   #",
      "# $^   #",
      "#   .  #",
      "########",
    ]);
    const ids = [World.boxIdAt(puzzle, 2, 1), World.boxIdAt(puzzle, 2, 2)];
    // The first box falls, then around to the left of the second.
    taps(puzzle, "RLD");
    // The fall took the first box out of the pool, and the second moved into its place.
    const index = EntityPool.indexOf(puzzle.boxes, 1);
    taps(puzzle, "R");
    expect([ids, index, changesOf(puzzle)]).toStrictEqual([
      [0, 1],
      0,
      [
        [World.Change.holeFilled, 0, 11],
        [World.Change.holeFilled, 1, 19],
      ],
    ]);
  });

  it("record an undo, and keep the record of what it undid", () => {
    const puzzle = start(LEVEL);
    taps(puzzle, "R");
    undo(puzzle);
    expect(World.boardText(puzzle)).toStrictEqual(LEVEL);
    // Nothing is popped: a view that looks now is told of the fall and of the undo, in order.
    expect(changesOf(puzzle)).toStrictEqual([
      [World.Change.holeFilled, 1, HOLE],
      [World.Change.undone, -1, -1],
    ]);
    taps(puzzle, "D");
    undo(puzzle);
    expect(changesOf(puzzle)).toStrictEqual([
      [World.Change.holeFilled, 1, HOLE],
      [World.Change.undone, -1, -1],
      [World.Change.undone, -1, -1],
    ]);
  });

  it("record nothing for a move, a push onto floor, a blocked move or an undo with no history left", () => {
    const puzzle = start(LEVEL);
    undo(puzzle);
    // Down and right, then up, which pushes the second box a cell up, and up again, which
    // would push it into the wall.
    taps(puzzle, "DRUU");
    expect(World.boardText(puzzle)).toStrictEqual([
      "#######",
      "# $$ .#",
      "# @^  #",
      "#     #",
      "#######",
    ]);
    expect(puzzle.cues).toStrictEqual({
      moves: 2,
      pushes: 1,
      holesFilled: 0,
      undos: 0,
      solved: 0,
    });
    expect(puzzle.changes.written).toBe(0);
  });

  it("hold the newest eight", () => {
    const puzzle = start(LEVEL);
    // Five times into the hole and back out: ten records, of which the first two are lost.
    for (let i = 0; i < 5; i++) {
      taps(puzzle, "R");
      undo(puzzle);
    }
    const { changes } = puzzle;
    expect([changes.written, changes.length]).toStrictEqual([10, 8]);
    expect(changesOf(puzzle)).toStrictEqual(
      Array.from({ length: 4 }, () => [
        [World.Change.holeFilled, 1, HOLE],
        [World.Change.undone, -1, -1],
      ]).flat()
    );
  });
});

/**
 * The replay's input, one entry per step: taps, holds and undos, mixed with idle steps. Each
 * move is held for 20 steps (every 4th) or 1, with the direction pressed on the first, then a
 * step with nothing held; every 5th move is followed by an undo and a step with nothing.
 */
const REPLAY_INPUTS: readonly World.Input[] = [..."RRDLLURDDRUULRRDDR"].flatMap(
  (char, i) => {
    const direction = DIRECTION_BY_CHAR[char as keyof typeof DIRECTION_BY_CHAR];
    const held = i % 4 === 0 ? 20 : 1;
    const steps: World.Input[] = Array.from({ length: held }, (_, s) => ({
      held: direction,
      pressed: s === 0 ? direction : null,
      undo: false,
    }));
    steps.push(NOTHING);
    if (i % 5 === 4) {
      steps.push({ held: null, pressed: null, undo: true }, NOTHING);
    }
    return steps;
  }
);

describe("replay", () => {
  /** The recorded box ids by cell index (row * 8 + column); every other cell has none (-1). */
  const RECORDED_BOX_IDS: Readonly<Record<number, number>> = { 18: 1, 19: 2 };
  const LEVEL = ["########", "#@ $ ^ #", "# $$ . #", "#  ..  #", "########"];

  /**
   * Plays the scripted input through arcadekit/game's Loop, one step per frame, the step order
   * the demo runs. Collects the events and counts the HUD samples the run reported.
   */
  const replay = () => {
    const loop = Game.makeLoop(PushPuzzle);
    const events: LevelSolved[] = [];
    let samples = 0;
    loop.subscribe((event) => {
      if (event._tag === "Hud") {
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
      board: World.boardText(puzzle),
      // Board text can't tell boxes apart; their stable ids can.
      boxIds: World.boardText(puzzle).flatMap((line, row) =>
        [...line].map((_, col) => World.boxIdAt(puzzle, col, row))
      ),
      moves: puzzle.moves,
      events,
      turns: puzzle.turns,
      samples,
    };
  };

  it("ends in the recorded state", () => {
    // Recorded from this script before the replay ran through a loop. A change here changes
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

describe("starting a run", () => {
  it("starts on the level named by levelId", () => {
    const content = Schema.decodeUnknownSync(PuzzleContent.PuzzleContent)({
      levels: [
        { id: "a", name: "A", rows: ["#####", "#@$.#", "#####"] },
        { id: "b", name: "B", rows: ["######", "# @$.#", "######"] },
      ],
    });
    expect(
      World.boardText(World.make({ content, levelId: "b" }))
    ).toStrictEqual(["######", "# @$.#", "######"]);
  });

  it("throws, naming the level, when levelId isn't in the content", () => {
    const config = configFor(["#####", "#@$.#", "#####"], {
      levelId: "missing",
    });
    expect(() => World.make(config)).toThrow(
      'push-puzzle content has no level "missing"'
    );
  });

  it("throws, naming historyCapacity, when it isn't a whole number of 1 or more", () => {
    for (const historyCapacity of [0, -1, 2.5, Number.NaN]) {
      const config = configFor(["#####", "#@$.#", "#####"], {
        historyCapacity,
      });
      expect(() => World.make(config)).toThrow(
        new RangeError(
          `push-puzzle's historyCapacity must be a whole number of 1 or more, got ${historyCapacity}`
        )
      );
    }
    // One turn is the least undo can go back.
    const puzzle = start(["#####", "#@  #", "#$. #", "#####"], {
      historyCapacity: 1,
    });
    taps(puzzle, "RR");
    undo(puzzle);
    undo(puzzle);
    expect(World.boardText(puzzle)).toStrictEqual([
      "#####",
      "# @ #",
      "#$. #",
      "#####",
    ]);
  });
});
