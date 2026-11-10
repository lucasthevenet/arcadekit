import { Result, Schema } from "effect";

/**
 * Turns one player's input for a step into a JSON value and back, so it can cross the network.
 * A lockstep session makes one from the one-player Schema of its simulation's
 * `Game.PlayerInputs`. `encode` copies: a device source refills one input object each step, and
 * the session keeps the encoded value until the host has it. Every peer, the host included,
 * steps on the decoded value, so a step sees the same input everywhere even where JSON loses
 * detail (-0 becomes 0).
 *
 * `decode` never throws: a value that isn't an input, as a peer on other code would send, fails
 * with a message saying why. The host removes a peer whose input fails; a peer stops on a step
 * from the host that fails.
 */
export interface InputCodec<Input> {
  readonly encode: (input: Input) => unknown;
  readonly decode: (encoded: unknown) => Result.Result<Input, string>;
}

/** The codec made for each Schema, so every session of a simulation shares one. */
const codecs = new WeakMap<Schema.Top, unknown>();

/**
 * A codec from an Effect Schema whose encoded side is JSON data. Decoding checks the input.
 *
 * One codec for each Schema, however many sessions ask: a codec keeps nothing of a run, and a
 * page that plays a second run then decodes through the same two functions as its first. Made
 * anew for each session, they would be new closures each run, which a JavaScript engine can't
 * treat as one known function: measured in V8, about 250 bytes more for each step a session
 * decodes.
 */
export const schemaCodec = <Input, Encoded>(
  schema: Schema.Codec<Input, Encoded>
): InputCodec<Input> => {
  const made = codecs.get(schema) as InputCodec<Input> | undefined;
  if (made !== undefined) {
    return made;
  }
  const encode = Schema.encodeSync(schema);
  const decode = Schema.decodeUnknownResult(schema);
  const codec: InputCodec<Input> = {
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- a copy through JSON keeps only what the wire carries.
    encode: (input) => JSON.parse(JSON.stringify(encode(input))) as unknown,
    decode: (encoded) =>
      Result.mapError(decode(encoded), (error) => error.message),
  };
  codecs.set(schema, codec);
  return codec;
};
