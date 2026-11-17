/**
 * The arithmetic behind `World.hash`: a 32-bit hash built one 32-bit word at
 * a time, with 32-bit integer arithmetic only, so it gives the same number on
 * every machine and in every JavaScript engine.
 *
 * `add` is the step of MurmurHash3. For a given state, two different words
 * always give two different states, and for a given word so do two different
 * states. A change to one word of the input therefore always changes the
 * result: it cannot cancel out further on.
 *
 * No Effect dependency.
 */
import type { Column, FieldKind, RefCodec } from "./component";

/** Folds one 32-bit word into a hash state. */
export const add = (state: number, word: number): number => {
  let k = Math.imul(word, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  const h = state ^ k;
  return (Math.imul((h << 13) | (h >>> 19), 5) + 0xe6546b64) | 0;
};

/** Scrambles a state so that every bit of it depends on every bit of the input. */
export const finish = (state: number): number => {
  let h = state;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};

export const addString = (state: number, text: string): number => {
  let h = add(state, text.length);
  for (let i = 0; i < text.length; i++) {
    h = add(h, text.charCodeAt(i));
  }
  return h;
};

// A float is hashed by its bits. Every NaN counts as the same NaN, because
// which bits a NaN carries is the one thing engines do not agree on.
const NAN_32 = 0x7fc00000;
const NAN_64_HIGH = 0x7ff80000;
const isNan32 = (bits: number): boolean =>
  (bits & 0x7f800000) === 0x7f800000 && (bits & 0x007fffff) !== 0;
const isNan64 = (low: number, high: number): boolean =>
  (high & 0x7ff00000) === 0x7ff00000 && ((high & 0x000fffff) | low) !== 0;

// Which half of a 64-bit float comes first in memory depends on the machine.
const LOW_FIRST = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const LOW = LOW_FIRST ? 0 : 1;
const HIGH = LOW_FIRST ? 1 : 0;

const float64 = new Float64Array(1);
const float64Words = new Uint32Array(float64.buffer);

const addFloat64 = (state: number, value: number): number => {
  float64[0] = value;
  const low = float64Words[LOW]!;
  const high = float64Words[HIGH]!;
  return isNan64(low, high)
    ? add(add(state, 0), NAN_64_HIGH)
    : add(add(state, low), high);
};

// What kind of value a field holds is part of its hash, so that the number
// 1, the string "1" and `true` are three different things.
const DATA_UNDEFINED = 1;
const DATA_NULL = 2;
const DATA_BOOLEAN = 3;
const DATA_NUMBER = 4;
const DATA_STRING = 5;
const DATA_BIGINT = 6;
const DATA_JSON = 7;

/** The JSON text of an array or an object. A function or a symbol has none. */
const jsonText = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch (error) {
    throw new Error(
      `A json field holds a value that JSON cannot write, so the world cannot be hashed or saved: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

/**
 * Folds one value of plain data into a hash state. Text, a number, a
 * boolean, a bigint, null and undefined are hashed by value. An array or an
 * object is hashed as the text `JSON.stringify` gives for it, which is the
 * form a snapshot saves it in.
 */
export const addData = (state: number, value: unknown): number => {
  switch (typeof value) {
    case "undefined": {
      return add(state, DATA_UNDEFINED);
    }
    case "boolean": {
      return add(add(state, DATA_BOOLEAN), value ? 1 : 0);
    }
    case "number": {
      return addFloat64(add(state, DATA_NUMBER), value);
    }
    case "string": {
      return addString(add(state, DATA_STRING), value);
    }
    case "bigint": {
      return addString(add(state, DATA_BIGINT), value.toString());
    }
    default: {
      if (value === null) {
        return add(state, DATA_NULL);
      }
      return addString(add(state, DATA_JSON), jsonText(value));
    }
  }
};

/**
 * Folds `count` 32-bit words into a hash state, in order.
 *
 * Four states take every fourth word each and are folded together at the
 * end. One state would have to wait for each step to finish before starting
 * the next; four overlap, which measured about a third faster. A changed
 * word still always changes the result.
 */
const addWords = (state: number, words: Uint32Array, count: number): number => {
  let a = state;
  let b = state ^ 1;
  let c = state ^ 2;
  let d = state ^ 3;
  let i = 0;
  for (; i + 3 < count; i += 4) {
    a = add(a, words[i]!);
    b = add(b, words[i + 1]!);
    c = add(c, words[i + 2]!);
    d = add(d, words[i + 3]!);
  }
  for (; i < count; i++) {
    a = add(a, words[i]!);
  }
  return add(add(add(a, b), c), d);
};

/** As `addWords`, for the bits of 32-bit floats. */
const addFloat32s = (
  state: number,
  words: Uint32Array,
  count: number
): number => {
  let a = state;
  let b = state ^ 1;
  let c = state ^ 2;
  let d = state ^ 3;
  let i = 0;
  for (; i + 3 < count; i += 4) {
    const w0 = words[i]!;
    const w1 = words[i + 1]!;
    const w2 = words[i + 2]!;
    const w3 = words[i + 3]!;
    a = add(a, isNan32(w0) ? NAN_32 : w0);
    b = add(b, isNan32(w1) ? NAN_32 : w1);
    c = add(c, isNan32(w2) ? NAN_32 : w2);
    d = add(d, isNan32(w3) ? NAN_32 : w3);
  }
  for (; i < count; i++) {
    const w = words[i]!;
    a = add(a, isNan32(w) ? NAN_32 : w);
  }
  return add(add(add(a, b), c), d);
};

/**
 * Folds rows `[0, count)` of a column into a hash state, in order. This is
 * the loop that decides what hashing a big world costs.
 */
export const addColumn = (
  state: number,
  kind: FieldKind,
  column: Column,
  count: number,
  codec?: RefCodec<unknown>
): number => {
  let h = state;
  switch (kind) {
    case "f32": {
      const { buffer, byteOffset } = column as Float32Array;
      return addFloat32s(h, new Uint32Array(buffer, byteOffset, count), count);
    }
    case "i32": {
      // The same bits, read as unsigned so that one loop serves both.
      const { buffer, byteOffset } = column as Int32Array;
      return addWords(h, new Uint32Array(buffer, byteOffset, count), count);
    }
    case "u32": {
      return addWords(h, column as Uint32Array, count);
    }
    case "u16": {
      const values = column as Uint16Array;
      for (let i = 0; i < count; i++) {
        h = add(h, values[i]!);
      }
      return h;
    }
    case "u8": {
      const values = column as Uint8Array;
      for (let i = 0; i < count; i++) {
        h = add(h, values[i]!);
      }
      return h;
    }
    case "entity": {
      // An entity's id is a whole number kept as a 64-bit float, and never
      // NaN: its two words as they are, low word first, in the loop that
      // takes words four at a time. Going through the loop for floats,
      // which looks at each for NaN, made hashing a world of four float
      // fields half as slow again.
      const { buffer, byteOffset } = column as Float64Array;
      const words = new Uint32Array(buffer, byteOffset, count * 2);
      if (LOW_FIRST) {
        return addWords(h, words, count * 2);
      }
      // A machine that keeps the high word first: the same words, in the
      // order every other machine has them.
      const ordered = new Uint32Array(count * 2);
      for (let i = 0; i < count; i++) {
        ordered[2 * i] = words[2 * i + 1]!;
        ordered[2 * i + 1] = words[2 * i]!;
      }
      return addWords(h, ordered, count * 2);
    }
    case "f64": {
      const { buffer, byteOffset } = column as Float64Array;
      const words = new Uint32Array(buffer, byteOffset, count * 2);
      for (let i = 0; i < count; i++) {
        const low = words[2 * i + LOW]!;
        const high = words[2 * i + HIGH]!;
        h = isNan64(low, high)
          ? add(add(h, 0), NAN_64_HIGH)
          : add(add(h, low), high);
      }
      return h;
    }
    case "json": {
      const values = column as unknown[];
      for (let i = 0; i < count; i++) {
        h = addData(h, values[i]);
      }
      return h;
    }
    case "ref": {
      const values = column as unknown[];
      for (let i = 0; i < count; i++) {
        h = addData(h, codec!.encode(values[i]));
      }
      return h;
    }
    case "transient": {
      // Not part of the game's state: not saved, so not hashed.
      return h;
    }
  }
};

/**
 * As `addColumn`, but each row is folded into its own state, `states[i]`.
 * Used where the order of the rows must not matter.
 */
export const addColumnPerRow = (
  states: Int32Array,
  kind: FieldKind,
  column: Column,
  count: number,
  codec?: RefCodec<unknown>
): void => {
  switch (kind) {
    case "f32": {
      const { buffer, byteOffset } = column as Float32Array;
      const words = new Uint32Array(buffer, byteOffset, count);
      for (let i = 0; i < count; i++) {
        const bits = words[i]!;
        states[i] = add(states[i]!, isNan32(bits) ? NAN_32 : bits);
      }
      return;
    }
    case "entity":
    case "f64": {
      const values = column as Float64Array;
      for (let i = 0; i < count; i++) {
        states[i] = addFloat64(states[i]!, values[i]!);
      }
      return;
    }
    case "json": {
      const values = column as unknown[];
      for (let i = 0; i < count; i++) {
        states[i] = addData(states[i]!, values[i]);
      }
      return;
    }
    case "ref": {
      const values = column as unknown[];
      for (let i = 0; i < count; i++) {
        states[i] = addData(states[i]!, codec!.encode(values[i]));
      }
      return;
    }
    case "transient": {
      return;
    }
    default: {
      const values = column as Uint32Array;
      for (let i = 0; i < count; i++) {
        states[i] = add(states[i]!, values[i]!);
      }
    }
  }
};

const KIND_CODE: Record<FieldKind, number> = {
  f32: 1,
  f64: 2,
  i32: 3,
  u32: 4,
  u16: 5,
  u8: 6,
  entity: 7,
  json: 8,
  ref: 9,
  transient: 10,
};

/**
 * A component's identity as the hash sees it: its name, and the name and
 * kind of each of its fields, in the order they were defined.
 */
export const shapeOf = (
  name: string,
  fields: readonly string[],
  kinds: readonly FieldKind[]
): number => {
  let h = addString(0, name);
  h = add(h, fields.length);
  for (let f = 0; f < fields.length; f++) {
    h = add(addString(h, fields[f]!), KIND_CODE[kinds[f]!]);
  }
  return finish(h);
};
