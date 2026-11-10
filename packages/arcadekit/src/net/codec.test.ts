import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { schemaCodec } from "./codec";

const Move = Schema.Struct({ n: Schema.Finite });

describe(schemaCodec, () => {
  const codec = schemaCodec(Move);

  it("decodes what it encoded", () => {
    expect(codec.decode(codec.encode({ n: 3 }))).toStrictEqual(
      Result.succeed({ n: 3 })
    );
  });

  it("fails, without throwing, on a value that isn't an input, saying why", () => {
    const decoded = codec.decode({ n: "x" });
    expect(Result.isFailure(decoded)).toBe(true);
    expect(Result.isFailure(decoded) && decoded.failure).toContain("n");
    expect(Result.isFailure(codec.decode(null))).toBe(true);
  });

  it("encodes a copy", () => {
    const input = { n: 1 };
    const encoded = codec.encode(input);
    input.n = 2;
    expect(encoded).toStrictEqual({ n: 1 });
  });

  it("encodes what the wire carries: JSON turns -0 into 0, and a NaN into no number at all", () => {
    const anyNumber = schemaCodec(Schema.Struct({ n: Schema.Number }));
    expect(anyNumber.decode(anyNumber.encode({ n: -0 }))).toStrictEqual(
      Result.succeed({ n: 0 })
    );
    expect(anyNumber.encode({ n: Number.NaN })).toStrictEqual({ n: null });
    expect(
      Result.isFailure(anyNumber.decode(anyNumber.encode({ n: Number.NaN })))
    ).toBe(true);
  });

  it("is one codec for each Schema, so every session of a simulation shares it", () => {
    expect(schemaCodec(Move)).toBe(codec);
    expect(schemaCodec(Schema.Struct({ n: Schema.Finite }))).not.toBe(codec);
  });

  it("throws on encoding a value its Schema refuses", () => {
    expect(() => codec.encode({ n: "x" } as never)).toThrow("n");
  });
});
