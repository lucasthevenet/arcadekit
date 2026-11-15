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
import type { Column, FieldKind } from "./component";

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

// What kind of value a `ref` field holds is part of its hash, so that the
// number 1, the string "1" and `true` are three different things.
const REF_UNDEFINED = 1;
const REF_NULL = 2;
const REF_BOOLEAN = 3;
const REF_NUMBER = 4;
const REF_STRING = 5;
const REF_BIGINT = 6;
const REF_OTHER = 7;

/**
 * Folds a value of a `ref` field into a hash state. Strings, numbers,
 * booleans, bigints, null and undefined are hashed by value. Anything else
 * (an object, a function, a symbol) only counts as "something is here": two
 * different objects hash alike.
 */
export const addRef = (state: number, value: unknown): number => {
  switch (typeof value) {
    case "undefined": {
      return add(state, REF_UNDEFINED);
    }
    case "boolean": {
      return add(add(state, REF_BOOLEAN), value ? 1 : 0);
    }
    case "number": {
      return addFloat64(add(state, REF_NUMBER), value);
    }
    case "string": {
      return addString(add(state, REF_STRING), value);
    }
    case "bigint": {
      return addString(add(state, REF_BIGINT), value.toString());
    }
    default: {
      return add(state, value === null ? REF_NULL : REF_OTHER);
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
  count: number
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
    case "u32":
    case "entity": {
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
    case "ref": {
      const values = column as unknown[];
      for (let i = 0; i < count; i++) {
        h = addRef(h, values[i]);
      }
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
  count: number
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
    case "f64": {
      const values = column as Float64Array;
      for (let i = 0; i < count; i++) {
        states[i] = addFloat64(states[i]!, values[i]!);
      }
      return;
    }
    case "ref": {
      const values = column as unknown[];
      for (let i = 0; i < count; i++) {
        states[i] = addRef(states[i]!, values[i]);
      }
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
  ref: 8,
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
