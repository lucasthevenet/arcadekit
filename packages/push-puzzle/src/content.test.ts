import { loadContent, memorySource } from "@gamekit/content";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { pushPuzzleContentDefinition } from "./index";

const load = (levels: unknown) =>
  Effect.runPromiseExit(
    loadContent({
      ...pushPuzzleContentDefinition,
      source: memorySource({ "levels.json": levels }),
    })
  );

const level = (id: string, rows: readonly string[]) => ({
  id,
  name: `Level ${id}`,
  rows,
});

const GOOD = level("first", ["#####", "#@$.#", "#####"]);

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
});
