/**
 * The columns a table holds a field in: a typed array for a number, an array
 * for any other value.
 *
 * No Effect dependency.
 */
import { isBoxed } from "./component.ts";
import type { FieldKind } from "./component.ts";

export type Column =
  | Float32Array
  | Float64Array
  | Int32Array
  | Uint32Array
  | Uint16Array
  | Uint8Array
  | unknown[];

export const makeColumn = (kind: FieldKind, capacity: number): Column => {
  switch (kind) {
    case "f32": {
      return new Float32Array(capacity);
    }
    case "f64": {
      return new Float64Array(capacity);
    }
    case "i32": {
      return new Int32Array(capacity);
    }
    case "u32": {
      return new Uint32Array(capacity);
    }
    case "entity": {
      // An id is a whole number below 2^53, which a 64-bit float holds.
      return new Float64Array(capacity);
    }
    case "u16": {
      return new Uint16Array(capacity);
    }
    case "u8": {
      return new Uint8Array(capacity);
    }
    case "json":
    case "ref":
    case "transient": {
      return Array.from({ length: capacity }, () => undefined);
    }
  }
};

export const growColumn = (
  kind: FieldKind,
  old: Column,
  capacity: number
): Column => {
  const next = makeColumn(kind, capacity);
  if (isBoxed(kind)) {
    const from = old as unknown[];
    const to = next as unknown[];
    for (let i = 0; i < from.length; i++) {
      to[i] = from[i];
    }
  } else {
    (next as Float32Array).set(old as Float32Array);
  }
  return next;
};
