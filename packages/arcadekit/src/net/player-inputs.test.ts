import { describe, expect, it } from "vitest";

import { combinePlayerInputs } from "./index";
import type { ConfirmedStep } from "./index";

const PLAYERS = ["host", "p1", "p2"];

const confirmed = (
  inputs: readonly (readonly [string, number])[],
  removed: readonly string[] = []
): ConfirmedStep<number> => ({
  inputs: inputs.map(([player, input]) => ({ player, input })),
  removed,
});

describe(combinePlayerInputs, () => {
  it("puts each player's input at its slot in the run's player order", () => {
    const combine = combinePlayerInputs<number>(PLAYERS);
    expect(
      combine(
        confirmed([
          ["p2", 30],
          ["host", 10],
          ["p1", 20],
        ])
      )
    ).toStrictEqual({ players: [10, 20, 30], leaving: [] });
  });

  it("leaves null at the slot of a player with no input in the step", () => {
    const combine = combinePlayerInputs<number>(PLAYERS);
    expect(combine(confirmed([["p2", 30]]))).toStrictEqual({
      players: [null, null, 30],
      leaving: [],
    });
  });

  it("lists the removed players' slots as leaving, in ascending order", () => {
    const combine = combinePlayerInputs<number>(PLAYERS);
    expect(combine(confirmed([["host", 10]], ["p2", "p1"]))).toStrictEqual({
      players: [10, null, null],
      leaving: [1, 2],
    });
  });

  it("skips a player who is not in the run's player order", () => {
    const combine = combinePlayerInputs<number>(PLAYERS);
    expect(
      combine(
        confirmed(
          [
            ["host", 10],
            ["stranger", 99],
          ],
          ["stranger"]
        )
      )
    ).toStrictEqual({ players: [10, null, null], leaving: [] });
  });

  it("refills one object, and forgets the step before", () => {
    const combine = combinePlayerInputs<number>(PLAYERS);
    const first = combine(
      confirmed(
        [
          ["host", 1],
          ["p1", 2],
        ],
        ["p2"]
      )
    );
    const { players, leaving } = first;
    const second = combine(confirmed([["host", 3]]));
    expect(second).toBe(first);
    expect(second.players).toBe(players);
    expect(second.leaving).toBe(leaving);
    expect(second).toStrictEqual({ players: [3, null, null], leaving: [] });
  });

  it("keeps a slot for every player, whoever has left", () => {
    const combine = combinePlayerInputs<number>(PLAYERS);
    combine(confirmed([["host", 1]], ["p1"]));
    expect(combine(confirmed([["host", 2]])).players).toHaveLength(3);
  });
});
