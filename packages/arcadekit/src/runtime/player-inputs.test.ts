import { describe, expect, it } from "vitest";

import { GameLoop, soloInput } from "./index";
import type { GameSimulation, PlayerInputs, StepInput } from "./index";

describe(soloInput, () => {
  it("puts the source's input at slot 0, with nobody leaving", () => {
    const input = soloInput<number>({ read: (step) => step * 10 });
    expect(input.read(3)).toStrictEqual({ players: [30], leaving: [] });
  });

  it("refills one object, so a step allocates nothing", () => {
    const input = soloInput<number>({ read: (step) => step });
    const first = input.read(0);
    const { players } = first;
    const second = input.read(1);
    expect(second).toBe(first);
    expect(second.players).toBe(players);
    expect(second.players).toStrictEqual([1]);
  });

  it("passes the source's own object through, not a copy", () => {
    const move = { x: 0 };
    const input = soloInput({ read: () => move });
    expect(input.read(0).players[0]).toBe(move);
  });

  it("reaches the source's endStep and endFrame", () => {
    const calls: string[] = [];
    const input = soloInput<null>({
      read: () => null,
      endStep: () => calls.push("endStep"),
      endFrame: () => calls.push("endFrame"),
    });
    input.endStep?.();
    input.endFrame?.();
    expect(calls).toStrictEqual(["endStep", "endFrame"]);
  });

  it("works with a source that has no endStep or endFrame", () => {
    const input = soloInput<null>({ read: () => null });
    expect(() => {
      input.endStep?.();
      input.endFrame?.();
    }).not.toThrow();
  });

  it("feeds a GameLoop whose simulation reads each player by slot", () => {
    const game: GameSimulation<null, number[], PlayerInputs<number>, never> = {
      create: () => [],
      step: (seen, input) => {
        seen.push(input.players[0] ?? -1, input.leaving.length);
      },
      drainEvents: () => [],
    };
    const loop = new GameLoop(game);
    loop.start(null, 1, 0);
    const source: StepInput<number> = { read: (step) => step + 5 };
    loop.frame(soloInput(source), { steps: 3 }, 0);
    expect(loop.state).toStrictEqual([5, 0, 6, 0, 7, 0]);
  });
});
