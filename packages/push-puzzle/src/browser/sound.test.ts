import { AudioSystem } from "arcadekit/audio";
import { describe, expect, it } from "vitest";

import type { Puzzle, PushPuzzleCues } from "../world";
import { PushPuzzleSoundView } from "./sound";

// The sound view only reads `puzzle.cues`, so each run here is a Puzzle with just its counters,
// bumped by hand the way steps would.

const SOUNDS = {
  move: "s-move",
  push: "s-push",
  hole: "s-hole",
  undo: "s-undo",
  solved: "s-solved",
} as const;

const run = (): Puzzle & { cues: PushPuzzleCues } =>
  ({
    cues: { moves: 0, pushes: 0, holesFilled: 0, undos: 0, solved: 0 },
  }) as unknown as Puzzle & { cues: PushPuzzleCues };

/** A sound view over an audio system that records what it plays. */
const listen = () => {
  const played: string[] = [];
  const audio = AudioSystem.make({
    play: (id) => {
      played.push(id);
    },
  });
  return { view: new PushPuzzleSoundView(audio, SOUNDS), played };
};

describe("the sound view", () => {
  it("plays a sound for each counter that went up since the last frame", () => {
    const { view, played } = listen();
    const puzzle = run();
    view.render(puzzle);
    puzzle.cues.moves += 1;
    view.render(puzzle);
    view.render(puzzle);
    puzzle.cues.pushes += 1;
    puzzle.cues.holesFilled += 1;
    view.render(puzzle);
    puzzle.cues.undos += 1;
    view.render(puzzle);
    puzzle.cues.pushes += 1;
    puzzle.cues.solved += 1;
    view.render(puzzle);
    expect(played).toStrictEqual([
      "s-move",
      "s-push",
      "s-hole",
      "s-undo",
      "s-push",
      "s-solved",
    ]);
  });

  it("plays once per counter per frame, however far it went", () => {
    const { view, played } = listen();
    const puzzle = run();
    view.render(puzzle);
    puzzle.cues.moves += 3;
    view.render(puzzle);
    expect(played).toStrictEqual(["s-move"]);
  });

  it("takes the counts on a run's first frame without playing", () => {
    const { view, played } = listen();
    const puzzle = run();
    puzzle.cues.moves = 5;
    puzzle.cues.undos = 2;
    view.render(puzzle);
    view.render(puzzle);
    expect(played).toStrictEqual([]);
  });

  it("starts over for a new run and after no run", () => {
    const { view, played } = listen();
    const first = run();
    first.cues.moves = 4;
    view.render(first);
    // A restart: the new run's counters start lower, which plays nothing.
    const second = run();
    view.render(second);
    second.cues.moves = 1;
    view.render(second);
    // Back to the menu, then the same level again with counts already taken.
    view.render(null);
    second.cues.moves = 2;
    view.render(second);
    second.cues.moves = 3;
    view.render(second);
    expect(played).toStrictEqual(["s-move", "s-move"]);
  });
});
