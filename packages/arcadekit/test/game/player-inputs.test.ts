import { Result, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import * as Game from "../../src/game/index";

// A small game for several players: each step adds every player's `n` to its total, by slot, and
// counts the players who left.

const Move = Schema.Struct({ n: Schema.Finite });
type Move = typeof Move.Type;

const Moves = Game.PlayerInputs(Move);

interface Totals {
  readonly totals: number[];
  left: number;
}

const createTotals = (config: { readonly players: number }): Totals => ({
  totals: Array.from({ length: config.players }, () => 0),
  left: 0,
});

const addMoves = (state: Totals, input: Game.PlayerInputs<Move>) => {
  for (let slot = 0; slot < input.players.length; slot++) {
    state.totals[slot]! += input.players[slot]?.n ?? 0;
  }
  state.left += input.leaving.length;
};

class Sum extends Game.Simulation("Sum", {
  input: Moves,
  create: createTotals,
  step: addMoves,
}) {}

/** The players' input annotated and checked after `Game.PlayerInputs` made it: still one. */
const CheckedMoves = Moves.annotate({
  description: "Every player's move",
}).check(
  Schema.makeFilter((input) => input.players.length <= 4, {
    title: "at most four players",
  })
);

class Checked extends Game.Simulation("Checked", {
  input: CheckedMoves,
  create: createTotals,
  step: addMoves,
}) {}

/** The same game again, checked first and annotated after: the annotation then lands on the check. */
class CheckedFirst extends Game.Simulation("CheckedFirst", {
  input: Moves.check(
    Schema.makeFilter((input) => input.leaving.length <= 4)
  ).annotate({ title: "Moves" }),
  create: createTotals,
  step: addMoves,
}) {}

/** The same step input as a struct written by hand: no host can read one player's Schema from it. */
class ByHand extends Game.Simulation("ByHand", {
  input: Schema.Struct({
    players: Schema.Array(Schema.NullOr(Move)),
    leaving: Schema.Array(Schema.Int),
  }),
  create: createTotals,
  step: addMoves,
}) {}

/** A game for one player: its step input is the player's own. */
class Alone extends Game.Simulation("Alone", {
  input: Move,
  create: () => ({ total: 0 }),
  step: (state, input) => {
    state.total += input.n;
  },
}) {}

const notPlayerInputs = (name: string) =>
  `Simulation "${name}" can't seat several players: its \`input\` was not declared with Game.PlayerInputs. Declare \`input: Game.PlayerInputs(OnePlayersInput)\`, from the Schema of one player's input for one step. A struct with \`players\` and \`leaving\` written by hand is not one: a host reads one player's Schema from what Game.PlayerInputs returns.`;

describe("Game.PlayerInputs", () => {
  it("is the Schema of every player's input by slot, and the slots leaving", () => {
    expectTypeOf<typeof Moves.Type>().toEqualTypeOf<Game.PlayerInputs<Move>>();
    expectTypeOf<Game.InputOf<typeof Sum>>().toEqualTypeOf<
      Game.PlayerInputs<Move>
    >();
    const decode = Schema.decodeUnknownResult(Moves);
    expect(decode({ players: [{ n: 1 }, null], leaving: [1] })).toStrictEqual(
      Result.succeed({ players: [{ n: 1 }, null], leaving: [1] })
    );
    expect(
      [
        { players: [{ n: "x" }], leaving: [] },
        { players: [{ n: 1 }], leaving: [0.5] },
        { players: [{ n: 1 }] },
        [{ n: 1 }],
      ].map((value) => Result.isFailure(decode(value)))
    ).toStrictEqual([true, true, true, true]);
  });

  it("takes a value with the two fields as a players' input: the mark is in the types alone", () => {
    const input: Game.PlayerInputs<Move> = { players: [{ n: 2 }], leaving: [] };
    expect(Object.keys(input)).toStrictEqual(["players", "leaving"]);
    const loop = Game.makeLoop(Sum);
    loop.start({ players: 2 }, 1, 0);
    loop.frame(
      { read: () => ({ players: [{ n: 2 }, { n: 3 }], leaving: [1] }) },
      { steps: 2 },
      0
    );
    expect(loop.state).toStrictEqual({ totals: [4, 6], left: 2 });
  });

  it("gives a host the Schema of one player's input", () => {
    const player = Game.playerInputSchema(Sum);
    expectTypeOf(player).toEqualTypeOf<Schema.Codec<Move, unknown>>();
    expectTypeOf<
      Game.PlayerInputOf<Game.InputOf<typeof Sum>>
    >().toEqualTypeOf<Move>();
    expect(player).toBe(Move);
  });

  it("is still one once annotated and checked", () => {
    expectTypeOf(Game.playerInputSchema(Checked)).toEqualTypeOf<
      Schema.Codec<Move, unknown>
    >();
    expect(Game.playerInputSchema(Checked)).toBe(Move);
    expect(Game.playerInputSchema(CheckedFirst)).toBe(Move);
    // And its check still holds: it is the same Schema, with more asked of it.
    const decode = Schema.decodeUnknownResult(CheckedMoves);
    expect(
      [4, 5].map((players) =>
        Result.isSuccess(
          decode({
            players: Array.from({ length: players }, () => null),
            leaving: [],
          })
        )
      )
    ).toStrictEqual([true, false]);
  });

  it("refuses a struct written by hand where a host asks for a players' input, by type and by throwing", () => {
    expectTypeOf<Game.PlayerInputOf<Game.InputOf<typeof ByHand>>>().toBeNever();
    expect(() =>
      // @ts-expect-error -- The error says to declare the simulation's `input` with Game.PlayerInputs(OnePlayersInput).
      Game.playerInputSchema(ByHand)
    ).toThrow(notPlayerInputs("ByHand"));
  });

  it("refuses such a struct by throwing alone where the step input's type is named", () => {
    // No type error: a struct with the two fields has the type of a players' input, whose mark
    // is optional. Only a host that infers `Input` from the simulation can tell, so a builder
    // that is to refuse one by type takes the simulation's `Input` as a type parameter.
    const named: Game.PlayersSimulation<
      { readonly players: number },
      Totals,
      Game.PlayerInputs<Move>,
      never,
      never,
      unknown
    > = ByHand;
    expect(() => Game.playerInputSchema(named)).toThrow(
      notPlayerInputs("ByHand")
    );
  });

  it("refuses a simulation for one player, by type and by throwing", () => {
    expectTypeOf<Game.PlayerInputOf<Game.InputOf<typeof Alone>>>().toBeNever();
    expect(() =>
      // @ts-expect-error -- A one-player step input seats nobody.
      Game.playerInputSchema(Alone)
    ).toThrow(notPlayerInputs("Alone"));
  });
});

describe(Game.soloInput, () => {
  it("puts the source's input at slot 0, with nobody leaving", () => {
    const input = Game.soloInput<number>({ read: (step) => step * 10 });
    expect(input.read(3)).toStrictEqual({ players: [30], leaving: [] });
  });

  it("refills one object, so a step allocates nothing", () => {
    const input = Game.soloInput<number>({ read: (step) => step });
    const first = input.read(0);
    const { players } = first;
    const second = input.read(1);
    expect(second).toBe(first);
    expect(second.players).toBe(players);
    expect(second.players).toStrictEqual([1]);
  });

  it("passes the source's own object through, not a copy", () => {
    const move = { x: 0 };
    const input = Game.soloInput({ read: () => move });
    expect(input.read(0).players[0]).toBe(move);
  });

  it("reaches the source's endStep and endFrame", () => {
    const calls: string[] = [];
    const input = Game.soloInput<null>({
      read: () => null,
      endStep: () => calls.push("endStep"),
      endFrame: () => calls.push("endFrame"),
    });
    input.endStep?.();
    input.endFrame?.();
    expect(calls).toStrictEqual(["endStep", "endFrame"]);
  });

  it("works with a source that has no endStep or endFrame", () => {
    const input = Game.soloInput<null>({ read: () => null });
    expect(() => {
      input.endStep?.();
      input.endFrame?.();
    }).not.toThrow();
  });

  it("feeds a loop whose simulation reads each player by slot", () => {
    const loop = Game.makeLoop(Sum);
    loop.start({ players: 1 }, 1, 0);
    const source: Game.StepInput<Move> = { read: (step) => ({ n: step + 5 }) };
    loop.frame(Game.soloInput(source), { steps: 3 }, 0);
    expect(loop.state).toStrictEqual({ totals: [18], left: 0 });
  });
});
