import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { jsonCodec, schemaCodec } from "./codec";

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
});

describe(jsonCodec, () => {
  it("decodes any JSON value as is", () => {
    const codec = jsonCodec<{ readonly n: number }>();
    expect(codec.decode(codec.encode({ n: -0 }))).toStrictEqual(
      Result.succeed({ n: 0 })
    );
  });
});
