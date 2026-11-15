/**
 * The bytes of a world's snapshot: how they are written and read back.
 * `World.snapshot` and `World.load` decide what goes in; this file is the
 * encoding.
 *
 * Whole numbers are little-endian. A column of numbers is the bytes of its
 * typed array, as they are in memory, which is the same thing on every
 * machine JavaScript runs on today. A value of a `json` field, or of a `ref`
 * field once its codec has encoded it, is a tag byte and then the value;
 * an array or an object is its JSON text. A `transient` field is not
 * written.
 *
 * No Effect dependency.
 */
import { isBoxed } from "./component";
import type { Column, FieldKind, RefCodec } from "./component";

/** Why a snapshot could not be taken, or could not be loaded. */
export type SnapshotProblem =
  | "not a snapshot"
  | "newer format"
  | "truncated"
  | "corrupt"
  | "unknown component"
  | "component changed"
  | "world not empty"
  | "cannot be saved";

/**
 * A snapshot could not be taken or loaded. `problem` says which kind of
 * trouble it is, for code; the message says it for a person, with the name
 * of the component or field where there is one.
 */
export class SnapshotError extends Error {
  override readonly name = "SnapshotError";
  readonly problem: SnapshotProblem;
  /** The component the problem is with, when it is with one. */
  readonly component: string | undefined;

  constructor(problem: SnapshotProblem, message: string, component?: string) {
    super(message);
    this.problem = problem;
    this.component = component;
  }
}

/** "AKWS": arcadekit world snapshot. */
export const MAGIC = 0x53574b41;
export const FORMAT = 1;
/** The last four bytes, so that a snapshot cut short at a boundary still shows. */
export const END = 0x21444e45;

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Bytes per element of a column of numbers. */
export const WIDTH: Record<
  Exclude<FieldKind, "json" | "ref" | "transient">,
  number
> = {
  f32: 4,
  f64: 8,
  i32: 4,
  u32: 4,
  entity: 4,
  u16: 2,
  u8: 1,
};

export const KIND_CODES: readonly FieldKind[] = [
  "f32",
  "f64",
  "i32",
  "u32",
  "u16",
  "u8",
  "entity",
  "json",
  "ref",
  "transient",
];

const TAG_UNDEFINED = 0;
const TAG_NULL = 1;
const TAG_FALSE = 2;
const TAG_TRUE = 3;
const TAG_NUMBER = 4;
const TAG_STRING = 5;
const TAG_BIGINT = 6;
const TAG_JSON = 7;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class Writer {
  private bytes: Uint8Array;
  private view: DataView;
  private at = 0;

  constructor(capacity: number) {
    if (!LITTLE_ENDIAN) {
      throw new SnapshotError(
        "cannot be saved",
        "Snapshots are written as the bytes of typed arrays, which this big-endian machine lays out the other way round."
      );
    }
    this.bytes = new Uint8Array(Math.max(64, capacity));
    this.view = new DataView(this.bytes.buffer);
  }

  private room(count: number): void {
    if (this.at + count <= this.bytes.length) {
      return;
    }
    let size = this.bytes.length * 2;
    while (size < this.at + count) {
      size *= 2;
    }
    const bytes = new Uint8Array(size);
    bytes.set(this.bytes.subarray(0, this.at));
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer);
  }

  u8(value: number): void {
    this.room(1);
    this.bytes[this.at++] = value;
  }

  u32(value: number): void {
    this.room(4);
    this.view.setUint32(this.at, value, true);
    this.at += 4;
  }

  f64(value: number): void {
    this.room(8);
    this.view.setFloat64(this.at, value, true);
    this.at += 8;
  }

  text(value: string): void {
    const utf8 = encoder.encode(value);
    this.u32(utf8.length);
    this.room(utf8.length);
    this.bytes.set(utf8, this.at);
    this.at += utf8.length;
  }

  /** The first `count` elements of a typed array, as its bytes. */
  numbers(column: ArrayBufferView, count: number, width: number): void {
    const length = count * width;
    this.room(length);
    this.bytes.set(
      new Uint8Array(column.buffer, column.byteOffset, length),
      this.at
    );
    this.at += length;
  }

  /**
   * One value of plain data. A string, a number, a boolean, a bigint, null
   * and undefined are written as they are, exactly: -0 and NaN too. An
   * array or an object is written as its JSON text. Returns false for a
   * value that has none: a function, a symbol, an object JSON cannot write.
   */
  value(value: unknown): boolean {
    switch (typeof value) {
      case "undefined": {
        this.u8(TAG_UNDEFINED);
        return true;
      }
      case "boolean": {
        this.u8(value ? TAG_TRUE : TAG_FALSE);
        return true;
      }
      case "number": {
        this.u8(TAG_NUMBER);
        this.f64(value);
        return true;
      }
      case "string": {
        this.u8(TAG_STRING);
        this.text(value);
        return true;
      }
      case "bigint": {
        this.u8(TAG_BIGINT);
        this.text(value.toString());
        return true;
      }
      default: {
        if (value === null) {
          this.u8(TAG_NULL);
          return true;
        }
        let json: string | undefined;
        try {
          json = JSON.stringify(value);
        } catch {
          return false;
        }
        if (json === undefined) {
          return false;
        }
        this.u8(TAG_JSON);
        this.text(json);
        return true;
      }
    }
  }

  /** The bytes written, in an array of exactly their length. */
  finish(): Uint8Array {
    return this.bytes.slice(0, this.at);
  }
}

export class Reader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private at = 0;

  constructor(bytes: Uint8Array) {
    if (!LITTLE_ENDIAN) {
      throw new SnapshotError(
        "not a snapshot",
        "Snapshots hold the bytes of typed arrays, which this big-endian machine reads the other way round."
      );
    }
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** How many bytes are left to read. */
  get left(): number {
    return this.bytes.length - this.at;
  }

  /** Refuses to go on unless `count` more bytes are there. */
  need(count: number): void {
    if (count > this.left) {
      throw new SnapshotError(
        "truncated",
        `The snapshot ends ${count - this.left} bytes short of what it says it holds.`
      );
    }
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.at++]!;
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.at, true);
    this.at += 4;
    return value;
  }

  f64(): number {
    this.need(8);
    const value = this.view.getFloat64(this.at, true);
    this.at += 8;
    return value;
  }

  /**
   * A count of things that each take at least `each` bytes. Checked against
   * what is left before anything is allocated for it, so that a damaged
   * count cannot ask for the moon.
   */
  count(each: number): number {
    const value = this.u32();
    if (each > 0) {
      this.need(value * each);
    }
    return value;
  }

  text(): string {
    const length = this.count(1);
    try {
      const value = decoder.decode(
        this.bytes.subarray(this.at, this.at + length)
      );
      this.at += length;
      return value;
    } catch {
      throw new SnapshotError(
        "corrupt",
        "The snapshot holds text that is not text."
      );
    }
  }

  /** Fills the first `count` elements of a typed array from its bytes. */
  numbers(column: ArrayBufferView, count: number, width: number): void {
    const length = count * width;
    this.need(length);
    new Uint8Array(column.buffer, column.byteOffset, length).set(
      this.bytes.subarray(this.at, this.at + length)
    );
    this.at += length;
  }

  value(): unknown {
    const tag = this.u8();
    switch (tag) {
      case TAG_UNDEFINED: {
        return undefined;
      }
      case TAG_NULL: {
        return null;
      }
      case TAG_FALSE: {
        return false;
      }
      case TAG_TRUE: {
        return true;
      }
      case TAG_NUMBER: {
        return this.f64();
      }
      case TAG_STRING: {
        return this.text();
      }
      case TAG_BIGINT: {
        const digits = this.text();
        try {
          return BigInt(digits);
        } catch {
          throw new SnapshotError(
            "corrupt",
            "The snapshot holds a big integer that is not one."
          );
        }
      }
      case TAG_JSON: {
        const json = this.text();
        try {
          return JSON.parse(json);
        } catch {
          throw new SnapshotError(
            "corrupt",
            "The snapshot holds an array or an object that is not JSON."
          );
        }
      }
      default: {
        throw new SnapshotError(
          "corrupt",
          `The snapshot holds a value of a kind (${tag}) this version does not know.`
        );
      }
    }
  }
}

/**
 * Writes rows `[0, count)` of a column. Returns the row it could not write,
 * or -1. A `transient` field writes nothing.
 */
export const writeColumn = (
  writer: Writer,
  kind: FieldKind,
  column: Column,
  count: number,
  codec?: RefCodec<unknown>
): number => {
  if (!isBoxed(kind)) {
    writer.numbers(column as Float32Array, count, WIDTH[kind as "f32"]);
    return -1;
  }
  if (kind === "transient") {
    return -1;
  }
  const values = column as unknown[];
  for (let row = 0; row < count; row++) {
    let value = values[row];
    if (kind === "ref") {
      try {
        value = codec!.encode(value);
      } catch {
        return row;
      }
    }
    if (!writer.value(value)) {
      return row;
    }
  }
  return -1;
};

/**
 * Reads rows `[0, count)` of a column. A `transient` field reads nothing
 * and stays undefined. A codec that refuses a value throws what it throws.
 */
export const readColumn = (
  reader: Reader,
  kind: FieldKind,
  column: Column,
  count: number,
  codec?: RefCodec<unknown>
): void => {
  if (!isBoxed(kind)) {
    reader.numbers(column as Float32Array, count, WIDTH[kind as "f32"]);
    return;
  }
  if (kind === "transient") {
    return;
  }
  const values = column as unknown[];
  for (let row = 0; row < count; row++) {
    const value = reader.value();
    values[row] = kind === "ref" ? codec!.decode(value) : value;
  }
};
