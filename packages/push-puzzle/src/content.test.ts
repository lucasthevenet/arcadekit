import { ContentSource } from "arcadekit/content";
import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PushPuzzleContent } from "./content";
import { PuzzleContent } from "./schema";

const load = (levels: unknown) =>
  Effect.runPromiseExit(
    PushPuzzleContent.read(ContentSource.fromRecord({ "levels.json": levels }))
  );

const level = (id: string, rows: readonly string[]) => ({
  id,
  name: `Level ${id}`,
  rows,
});

const GOOD = level("first", ["#####", "#@$.#", "#####"]);

/** Decodes `levels` with the schema alone, as code that skips the loader does. */
const decodeLevels = (levels: unknown) => () =>
  Schema.decodeUnknownSync(PuzzleContent)({ levels });

/** The failure message, or "" if loading succeeded. */
const failure = async (levels: unknown) => {
  const exit = await load(levels);
  return Exit.isFailure(exit) ? JSON.stringify(exit) : "";
};

describe("push-puzzle content", () => {
  it("loads valid levels", async () => {
    const holes = level("holes", ["######", "#+$^ #", "# *  #", "######"]);
    const exit = await load([GOOD, holes]);
    expect(exit).toStrictEqual(Exit.succeed({ levels: [GOOD, holes] }));
  });

  it.each([
    ["an unknown character", ["#####", "#@$x#", "#####"], "unknown character"],
    ["no player", ["#####", "# $.#", "#####"], "no player"],
    ["two players", ["######", "#@$.@#", "######"], "2 players"],
    ["fewer boxes than goals", ["######", "#@$..#", "######"], "1 box"],
    ["no goal", ["#####", "#@$ #", "#####"], "no goal"],
    // No cell at all: it is told what it lacks, as any other level is.
    ["rows that are all empty", ["", ""], "no player"],
  ])("rejects a level with %s, naming the level", async (_, rows, problem) => {
    const message = await failure([GOOD, level("broken", rows)]);
    expect(message).toContain('level \\"broken\\"');
    expect(message).toContain(problem);
  });

  it("rejects duplicate level ids", async () => {
    const message = await failure([GOOD, GOOD]);
    expect(message).toContain('level \\"first\\"');
    expect(message).toContain("more than once");
  });

  it("rejects a file that isn't a list of levels", async () => {
    await expect(failure({ levels: "nope" })).resolves.toContain(
      "Invalid content"
    );
    await expect(failure([])).resolves.toContain("Invalid content");
  });

  it.each([
    ["no player", ["#####", "# $.#", "#####"], "no player"],
    ["no goal", ["#####", "#@$ #", "#####"], "no goal"],
  ])(
    "rejects a level with %s when decoded with the schema alone",
    (_, rows, problem) => {
      expect(decodeLevels([level("broken", rows)])).toThrow(problem);
    }
  );

  it("rejects duplicate level ids when decoded with the schema alone", () => {
    expect(decodeLevels([GOOD, GOOD])).toThrow(
      'level "first" appears more than once'
    );
  });
});
