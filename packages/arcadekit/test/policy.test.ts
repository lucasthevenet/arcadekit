import { describe, expect, it } from "vitest";

import { generates, play } from "./policy-game";

// Node's own, declared here, since the tests are compiled with no types
// but their own.
declare const process: { readonly execPath: string };

const { execFileSync } = (await import(
  /* @vite-ignore */ "node:child_process" as string
)) as {
  readonly execFileSync: (
    file: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly encoding: "utf8" }
  ) => string;
};

/**
 * Plays the game of `policy-game.ts` in a process of its own and gives
 * what it printed: whether that process may make code from text, and how
 * the game went.
 */
const playIn = (
  flags: readonly string[]
): { readonly generates: boolean; readonly game: unknown } =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        ...flags,
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        'const { generates, play } = await import("./test/policy-game.ts"); console.log(JSON.stringify({ generates: generates(), game: play() }));',
      ],
      { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" }
    )
      .trim()
      .split("\n")
      .pop()!
  );

describe("under a policy that forbids making code from text", () => {
  // What a page with a strict Content Security Policy is to V8: `eval` and
  // `new Function` throw.
  const strict = ["--disallow-code-generation-from-strings"];

  it("a game plays as it does anywhere: every loop, every kind of field, a refusal, a save and a load", () => {
    const here = play();
    // The game is one that does something, and refuses what it should.
    expect(here.hash).toBe(here.loaded);
    expect(here.outcomes).toStrictEqual(["paid", "refused"]);
    expect(here.noticed).toBeGreaterThan(0);
    expect(here.refusals).toStrictEqual([
      expect.stringContaining(
        'An assignment to "policy/Position.x" was made while the world is frozen'
      ),
      expect.stringContaining(
        '"policy/Velocity.x" was assigned to through a query that only reads'
      ),
      expect.stringContaining(
        '"policy/Follows" is a relation, and its target is not written'
      ),
    ]);

    const there = playIn(strict);
    // The policy was in force there, and is not here.
    expect(there.generates).toBe(false);
    expect(generates()).toBe(true);
    expect(there.game).toStrictEqual(JSON.parse(JSON.stringify(here)));
  }, 30_000);

  it("is a policy the test would notice the lack of", () => {
    expect(playIn([]).generates).toBe(true);
  }, 30_000);
});
