import { Schema } from "effect";

/**
 * Turns one player's input for a step into a JSON value and back, so it can cross the network.
 * `encode` must copy: a device source refills one input object each step, and the session keeps
 * the encoded value until the host has it. Every peer, the host included, steps on the decoded
 * value, so a step sees the same input everywhere even where JSON loses detail (-0 becomes 0).
 */
export interface InputCodec<Input> {
  readonly encode: (input: Input) => unknown;
  readonly decode: (encoded: unknown) => Input;
}

/** A codec for input that is already plain JSON data: numbers, strings, booleans, arrays, objects. */
export const jsonCodec = <Input>(): InputCodec<Input> => ({
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- a copy through JSON keeps only what the wire carries.
  encode: (input) => JSON.parse(JSON.stringify(input)) as unknown,
  decode: (encoded) => encoded as Input,
});

/** A codec from an Effect Schema whose encoded side is JSON data. Decoding checks the input. */
export const schemaCodec = <Input, Encoded>(
  schema: Schema.Codec<Input, Encoded>
): InputCodec<Input> => {
  const encode = Schema.encodeSync(schema);
  const decode = Schema.decodeUnknownSync(schema);
  return {
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- a copy through JSON keeps only what the wire carries.
    encode: (input) => JSON.parse(JSON.stringify(encode(input))) as unknown,
    decode: (encoded) => decode(encoded),
  };
};
