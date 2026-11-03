import { readFileSync } from "node:fs";

import { ContentError, loadContent } from "@gamekit/content";
import type { ContentSource } from "@gamekit/content";
import {
  CONTENT_FILES,
  PuzzleContent,
  createPuzzle,
  findLevelProblems,
  step,
} from "@gamekit/push-puzzle";
import type { Direction, PushPuzzleEvent } from "@gamekit/push-puzzle";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

// Checks this game's real level file: it decodes, passes the level checks,
// and every level can be solved (by a known solution, in the fewest moves found).

const contentDir = new URL("../public/content/", import.meta.url);
const fileSource: ContentSource = (file) =>
  Effect.try({
    try: () =>
      JSON.parse(readFileSync(new URL(file, contentDir), "utf-8")) as unknown,
    catch: (cause) => new ContentError({ message: String(cause) }),
  });

const content = await Effect.runPromise(
  loadContent({
    schema: PuzzleContent,
    files: CONTENT_FILES,
    source: fileSource,
    validate: findLevelProblems,
  })
);

const SOLUTIONS: Record<string, string> = {
  "first-push": "DRLURR",
  // Fills the hole with one box, then rolls the other across it.
  "mind-the-gap": "URRUULDLDRRRR",
  // Three boxes, two holes, two goals: only one hole can be filled.
  "two-doors": "URRRDDLULURRRRURDDULLLDDDLLUULURRRRR",
};

const DIRECTIONS: Record<string, Direction> = {
  U: "up",
  D: "down",
  L: "left",
  R: "right",
};

describe("demo levels", () => {
  it("ships three levels, each with a known solution", () => {
    expect(content.levels.map((level) => level.id)).toStrictEqual(
      Object.keys(SOLUTIONS)
    );
  });

  it.each(Object.entries(SOLUTIONS))("%s can be solved", (levelId, moves) => {
    const puzzle = createPuzzle({ content, levelId }, 0);
    const events: PushPuzzleEvent[] = [];
    for (const char of moves) {
      const direction = DIRECTIONS[char]!;
      step(
        puzzle,
        { held: direction, pressed: direction, undo: false },
        1 / 60
      );
      step(puzzle, { held: null, pressed: null, undo: false }, 1 / 60);
      events.push(...puzzle.events.drain());
    }
    expect(events).toStrictEqual([
      { type: "levelSolved", moves: moves.length },
    ]);
  });
});
