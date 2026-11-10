import { readFileSync } from "node:fs";

import {
  LevelSolved,
  PushPuzzle,
  PushPuzzleContent,
} from "@arcadekit/push-puzzle";
import type { Direction } from "@arcadekit/push-puzzle";
import { ContentError } from "arcadekit/content";
import type { ContentSource } from "arcadekit/content";
import * as Scenario from "arcadekit/game/scenario";
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

const content = await Effect.runPromise(PushPuzzleContent.read(fileSource));

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

const scenario = Scenario.make(PushPuzzle);

/** One tap: a step with the direction pressed, then a step with nothing held. */
const tap = (direction: Direction) => [
  Scenario.step({ held: direction, pressed: direction, undo: false }),
  Scenario.step({ held: null, pressed: null, undo: false }),
];

describe("demo levels", () => {
  it("ships three levels, each with a known solution", () => {
    expect(content.levels.map((level) => level.id)).toStrictEqual(
      Object.keys(SOLUTIONS)
    );
  });

  it.each(Object.entries(SOLUTIONS))("%s can be solved", (levelId, moves) => {
    scenario(
      Scenario.given({ content, levelId }),
      [...moves].map((char) => tap(DIRECTIONS[char]!)),
      Scenario.reported(new LevelSolved({ moves: moves.length }))
    );
  });
});
