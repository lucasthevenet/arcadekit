import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import * as Game from "../game/index";
import { MAX_STEP_COMMANDS, payloadCodec } from "./codec";
import type { PayloadCodec, StepPayload } from "./codec";

const Move = Schema.Struct({ n: Schema.Number });

class JarFull extends Game.Rejection("JarFull", { room: Schema.Int }) {}

class Deposit extends Game.Command(
  "Deposit",
  { amount: Schema.Int },
  { rejects: [JarFull] }
) {}

/** Any number: a NaN passes its Schema, and is lost on the wire. */
class Tilt extends Game.Command("Tilt", { by: Schema.Number }) {}

/** A game with two commands: what a payload may carry besides a move. */
class Jar extends Game.Simulation("Jar", {
  input: Game.PlayerInputs(Move),
  commands: [Deposit, Tilt],
  create: (_config: null) => ({ coins: 0 }),
  step: () => undefined,
  apply: {
    Deposit: (jar, { amount }) => {
      jar.coins += amount;
    },
    Tilt: () => undefined,
  },
}) {}

/** A game with no command: its payload is its input alone. */
class Still extends Game.Simulation("Still", {
  input: Game.PlayerInputs(Move),
  create: (_config: null) => ({ steps: 0 }),
  step: () => undefined,
}) {}

/** A game whose one player's input may be null itself. */
class Maybe extends Game.Simulation("Maybe", {
  input: Game.PlayerInputs(Schema.NullOr(Move)),
  create: (_config: null) => ({ steps: 0 }),
  step: () => undefined,
}) {}

/** A command's wire form, for a command that has one. */
const wireOf = (command: Deposit | Tilt): unknown =>
  Result.getOrThrow(payloadCodec(Jar).encodeCommand(command));

/** A record that has been filled with nothing yet, told from any payload by its `input`. */
const UNFILLED = "unfilled";

/**
 * What `codec` decodes `encoded` to: the record it filled, or that it failed with a reason,
 * with the record it was handed to show that a failure fills nothing.
 */
const decoded = <PlayerInput, Command>(
  codec: PayloadCodec<PlayerInput, Command>,
  encoded: unknown
) => {
  const into: StepPayload<PlayerInput, Command> = {
    input: UNFILLED as PlayerInput,
    commands: [],
  };
  const issue = codec.decode(encoded, into);
  return issue === null ? into : { failed: typeof issue, into };
};

const FAILED = { failed: "string", into: { input: UNFILLED, commands: [] } };

/** The input a payload of the jar game decodes to, in a list, or "fails". */
const inputOf = (payload: unknown) => {
  const filled = decoded(payloadCodec(Jar), payload);
  return "failed" in filled ? "fails" : [filled.input];
};

describe(payloadCodec, () => {
  const codec = payloadCodec(Jar);

  it("puts a step with no command on the wire as its input alone, in a list", () => {
    expect(JSON.stringify(codec.encode({ n: 3 }, []))).toBe('[{"n":3}]');
  });

  it("puts null for the input while nothing is attached", () => {
    expect(JSON.stringify(codec.encode(null, []))).toBe("[null]");
    expect(decoded(codec, [null])).toStrictEqual({ input: null, commands: [] });
  });

  it("puts a step's commands after its input, each as its tag and fields, in the order sent", () => {
    const encoded = codec.encode({ n: 3 }, [
      wireOf(new Deposit({ amount: 5 })),
      wireOf(new Tilt({ by: 0.5 })),
    ]);
    expect(JSON.stringify(encoded)).toBe(
      '[{"n":3},{"_tag":"Deposit","amount":5},{"_tag":"Tilt","by":0.5}]'
    );
  });

  it("decodes what it encoded: the input, and each command as a value of its class", () => {
    const payload = decoded(
      codec,
      codec.encode({ n: 3 }, [wireOf(new Deposit({ amount: 5 }))])
    );
    expect(payload).toStrictEqual({
      input: { n: 3 },
      commands: [new Deposit({ amount: 5 })],
    });
    expect("commands" in payload && payload.commands[0]).toBeInstanceOf(
      Deposit
    );
  });

  it("decodes an input alone, the payload of most steps, as it decodes one with a command beside it", () => {
    // An input alone is decoded by the one-player Schema, with no tuple around it.
    const command = { _tag: "Deposit", amount: 1 };
    const inputs = [
      { n: 3 },
      { n: -0 },
      { n: 1, more: 2 },
      { n: "x" },
      {},
      7,
      [1],
      null,
    ];
    expect(inputs.map((input) => inputOf([input]))).toStrictEqual(
      inputs.map((input) => inputOf([input, command]))
    );
    expect([inputOf([{ n: 3 }]), inputOf([null])]).toStrictEqual([
      [{ n: 3 }],
      [null],
    ]);
  });

  it("decodes a null as the one-player Schema does, where that Schema takes a null itself", () => {
    // Here null is an input like another, not the lack of one.
    const maybe = payloadCodec(Maybe);
    expect([
      decoded(maybe, [null]),
      decoded(maybe, [{ n: 1 }]),
      decoded(maybe, maybe.encode(null, [])),
    ]).toStrictEqual([
      { input: null, commands: [] },
      { input: { n: 1 }, commands: [] },
      { input: null, commands: [] },
    ]);
  });

  it("encodes a copy of the input", () => {
    const input = { n: 1 };
    const encoded = codec.encode(input, []);
    input.n = 2;
    expect(encoded).toStrictEqual([{ n: 1 }]);
  });

  it("encodes what the wire carries: JSON turns -0 into 0, and a NaN into no number at all", () => {
    expect(decoded(codec, codec.encode({ n: -0 }, []))).toStrictEqual({
      input: { n: 0 },
      commands: [],
    });
    expect(codec.encode({ n: Number.NaN }, [])).toStrictEqual([{ n: null }]);
    expect(decoded(codec, codec.encode({ n: Number.NaN }, []))).toStrictEqual(
      FAILED
    );
  });

  it("throws on encoding an input its Schema refuses", () => {
    expect(() => codec.encode({ n: "x" } as never, [])).toThrow("n");
  });

  it.each([
    { what: "an input that isn't one", payload: [{ n: "x" }] },
    { what: "a bare input, in no list", payload: { n: 1 } },
    { what: "an empty list", payload: [] },
    { what: "null", payload: null },
    {
      what: "a command the simulation doesn't declare",
      payload: [{ n: 1 }, { _tag: "Nope" }],
    },
    {
      what: "a command whose field doesn't decode",
      payload: [{ n: 1 }, { _tag: "Deposit", amount: 1.5 }],
    },
    {
      what: "more commands than a step carries",
      payload: [
        { n: 1 },
        ...Array.from({ length: MAX_STEP_COMMANDS + 1 }, () => ({
          _tag: "Deposit",
          amount: 1,
        })),
      ],
    },
  ])(
    "fails on $what, without throwing and without filling anything",
    ({ payload }) => {
      expect(decoded(codec, payload)).toStrictEqual(FAILED);
    }
  );

  it("says why a payload failed", () => {
    const into = { input: null, commands: [] };
    expect([
      codec.decode([{ n: "x" }], into),
      codec.decode([{ n: 1 }, { _tag: "Deposit", amount: 1.5 }], into),
    ]).toStrictEqual([
      expect.stringContaining('"n"'),
      expect.stringContaining('"amount"'),
    ]);
  });

  it("takes as many commands as a step carries", () => {
    const full = decoded(codec, [
      { n: 1 },
      ...Array.from({ length: MAX_STEP_COMMANDS }, () => ({
        _tag: "Deposit",
        amount: 1,
      })),
    ]);
    expect("commands" in full && full.commands).toHaveLength(MAX_STEP_COMMANDS);
  });

  it("gives a command its wire form, and says why one can't cross the network", () => {
    expect(codec.encodeCommand(new Deposit({ amount: 5 }))).toStrictEqual(
      Result.succeed({ _tag: "Deposit", amount: 5 })
    );
    const lost = codec.encodeCommand(new Tilt({ by: Number.NaN }));
    expect(Result.isFailure(lost) && lost.failure).toContain("by");
  });

  it("takes nothing but its input for a simulation with no command", () => {
    const still = payloadCodec(Still);
    expect([
      decoded(still, still.encode({ n: 1 }, [])),
      decoded(still, [{ n: 1 }, { _tag: "Deposit", amount: 1 }]),
    ]).toStrictEqual([{ input: { n: 1 }, commands: [] }, FAILED]);
  });

  it("is one codec for each simulation, so every session of it shares one", () => {
    expect(payloadCodec(Jar)).toBe(codec);
    expect(payloadCodec(Still)).not.toBe(codec);
  });
});
