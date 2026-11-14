/**
 * Join codes: the six letters a host reads out so guests can find its room, such as `K7MQ2X`.
 *
 * The worker picks a fresh code for each room from random bytes, and a guest types it in any
 * case. Its letters can't be confused when read aloud or typed: no 0/O, no 1/I/L. Plain on
 * purpose (ADR-0024): a Schema, and the data work that reads a code from bytes, a typed string or
 * a path.
 *
 * @since 0.7.0
 */
import { Schema } from "effect";

/**
 * The letters a join code uses: no 0/O, 1/I/L, so it can be read aloud and typed.
 *
 * **When to use**
 *
 * To check what a player types as they type it, before `fromTyped` reads the whole code.
 *
 * **Example** (A letter a code may hold)
 *
 * ```ts
 * import { JoinCode } from "arcadekit/net/signalling";
 *
 * JoinCode.alphabet.includes("K"); // => true
 * JoinCode.alphabet.includes("O"); // => false
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * How many letters a join code has. 31^6 is about 900 million codes.
 *
 * **When to use**
 *
 * To size the field a player types a code in.
 *
 * **Example** (A code's length)
 *
 * ```ts
 * import { JoinCode } from "arcadekit/net/signalling";
 *
 * JoinCode.length; // => 6
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export const length = 6;

/**
 * The Schema of a join code: `length` letters of `alphabet`, upper case.
 *
 * **When to use**
 *
 * To decode a join code that arrives from the network, as the worker's `welcome` does. A code a
 * player typed is read with `fromTyped`.
 *
 * **Example** (A code and a look-alike)
 *
 * ```ts
 * import { JoinCode } from "arcadekit/net/signalling";
 * import { Schema } from "effect";
 *
 * Schema.is(JoinCode.JoinCode)("K7MQ2X"); // => true
 * Schema.is(JoinCode.JoinCode)("K7MQ2O"); // => false
 * ```
 *
 * @category schemas
 * @since 0.7.0
 */
export const JoinCode: Schema.String = Schema.String.check(
  Schema.isPattern(new RegExp(`^[${alphabet}]{${length}}$`, "u"))
);

/**
 * A join code: `length` letters of `alphabet`.
 *
 * **When to use**
 *
 * To type what a lobby shows and a guest joins with.
 *
 * **Example** (A code a lobby shows)
 *
 * ```ts
 * import type { JoinCode } from "arcadekit/net/signalling";
 *
 * const code: JoinCode.JoinCode = "K7MQ2X";
 * code.length; // => 6
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type JoinCode = typeof JoinCode.Type;

/**
 * Makes a join code from random bytes, such as `crypto.getRandomValues(new Uint8Array(32))`.
 *
 * **When to use**
 *
 * Where a room is opened, to pick its code. The signalling worker does.
 *
 * **Details**
 *
 * Bytes the alphabet doesn't divide evenly are skipped, so every code is equally likely. It gives
 * `undefined` in the unlikely case the bytes run out first.
 *
 * **Example** (A code from bytes, and too few of them)
 *
 * ```ts
 * import { JoinCode } from "arcadekit/net/signalling";
 *
 * JoinCode.fromBytes([9, 28, 10, 13, 23, 20]); // => "K7MQ2X"
 * JoinCode.fromBytes([255, 0]); // => undefined
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const fromBytes = (bytes: ArrayLike<number>): JoinCode | undefined => {
  const size = alphabet.length;
  const limit = Math.floor(256 / size) * size;
  let code = "";
  for (let i = 0; i < bytes.length && code.length < length; i++) {
    const byte = bytes[i]!;
    if (byte < limit) {
      code += alphabet[byte % size];
    }
  }
  return code.length === length ? code : undefined;
};

const isJoinCode = Schema.is(JoinCode);

/**
 * A join code as a person typed it, upper-cased and trimmed, or `undefined` if it can't be one.
 *
 * **When to use**
 *
 * Where a guest's code comes from a text field: a signalling room's `join` reads its code so.
 *
 * **Example** (A code typed in lower case)
 *
 * ```ts
 * import { JoinCode } from "arcadekit/net/signalling";
 *
 * JoinCode.fromTyped(" k7mq2x "); // => "K7MQ2X"
 * JoinCode.fromTyped("hello"); // => undefined
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const fromTyped = (typed: string): JoinCode | undefined => {
  const code = typed.trim().toUpperCase();
  return isJoinCode(code) ? code : undefined;
};

/**
 * The join code in a guest's `/join/<code>` path, read as `fromTyped` reads one, or `undefined`
 * for any other path, a malformed escape or a code that can't be one.
 *
 * **When to use**
 *
 * Where a request is routed to its room: the signalling worker and a local server route by it.
 *
 * **Example** (A guest's path and another)
 *
 * ```ts
 * import { JoinCode } from "arcadekit/net/signalling";
 *
 * JoinCode.fromPath("/join/k7mq2x"); // => "K7MQ2X"
 * JoinCode.fromPath("/host"); // => undefined
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const fromPath = (pathname: string): JoinCode | undefined => {
  const match = /^\/join\/(?<code>[^/]+)$/u.exec(pathname);
  if (match === null) {
    return undefined;
  }
  try {
    return fromTyped(decodeURIComponent(match.groups!.code!));
  } catch {
    return undefined;
  }
};
