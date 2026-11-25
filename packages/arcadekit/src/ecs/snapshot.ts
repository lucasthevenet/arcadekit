import type { Column } from "./column.ts";
/**
 * The encoding of a world's snapshot: how a number, a text, a value of plain
 * data and a column become bytes, and come back. `format.ts` says what a
 * snapshot holds and in what order.
 *
 * Integers are little-endian. A numeric column is the bytes of its typed array,
 * as they are in memory, which is the same on every machine JavaScript runs on
 * today. A `json` field's value, or a `ref` field's value once its codec has
 * encoded it, is a tag byte followed by the value; an array or an object is its
 * JSON text. A `transient` field isn't written.
 *
 * No Effect dependency.
 */
import { isBoxed } from "./component.ts";
import type { FieldKind, RefCodec } from "./component.ts";

/**
 * Why a snapshot couldn't be taken or loaded, as a `SnapshotError` gives it:
 *
 * - `"not a snapshot"`: the bytes don't begin as a snapshot does.
 * - `"newer format"`: a later version of arcadekit wrote the snapshot.
 * - `"truncated"`: the bytes end before what they say they hold.
 * - `"corrupt"`: the bytes hold what no world could have saved.
 * - `"unknown component"`: the snapshot holds a component this program
 *   doesn't define.
 * - `"component changed"`: a component's storage or fields differ from when
 *   the snapshot was taken, or a `ref` field's codec refuses a value.
 * - `"unknown store"`: the snapshot holds a store that the world doesn't have.
 * - `"store changed"`: a store refuses what the snapshot holds of it.
 * - `"world not empty"`: `World.load` was given a world that isn't empty.
 * - `"cannot be saved"`: the world holds a value with no saved form, or a
 *   spawn that a `CommandBuffer` hasn't applied.
 *
 * @category Models
 */
export type SnapshotProblem =
  | "not a snapshot"
  | "newer format"
  | "truncated"
  | "corrupt"
  | "unknown component"
  | "component changed"
  | "unknown store"
  | "store changed"
  | "world not empty"
  | "cannot be saved";

/**
 * What `World.snapshot`, `World.load`, `World.restore`, `readSnapshot` and
 * `writeSnapshot` throw when a snapshot can't be taken or loaded. `problem`
 * names the kind of failure for code. The message explains it for a person,
 * and names the component or field where there is one.
 *
 * @category Errors
 */
export class SnapshotError extends Error {
  override readonly name = "SnapshotError";
  /** The kind of failure. */
  readonly problem: SnapshotProblem;
  /** The component the problem concerns, if any. */
  readonly component: string | undefined;

  constructor(problem: SnapshotProblem, message: string, component?: string) {
    super(message);
    this.problem = problem;
    this.component = component;
  }
}

/** "AKWS": arcadekit world snapshot. */
export const MAGIC = 0x53574b41;
/**
 * Format 2 added singletons. Format 3 widened entity ids: a slot's generation
 * is four bytes instead of two, and an id is eight bytes instead of four, both
 * in a table's entity list and in an `entity` field. An older id is the same
 * number stored in fewer bytes. Format 4 added what a world's stores hold, and puts
 * the singletons and the stores before the tables, so that a reader looking
 * for a singleton stops short of the entities. Formats 1 to 3 are still read.
 */
export const FORMAT = 4;
/** The last four bytes, so a snapshot truncated at a boundary is still detected. */
export const END = 0x21444e45;

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Bytes per element of a numeric column. */
export const WIDTH: Record<
  Exclude<FieldKind, "json" | "ref" | "transient">,
  number
> = {
  f32: 4,
  f64: 8,
  i32: 4,
  u32: 4,
  entity: 8,
  u16: 2,
  u8: 1,
};

/** How a component's data is stored, by the byte a snapshot writes for it. */
export const STORAGES = ["table", "sparse", "singleton"] as const;

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

  /** Writes the first `count` elements of a typed array as bytes. */
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
   * Writes one value of plain data. Strings, numbers, booleans, bigints, null
   * and undefined are written exactly, including -0 and NaN. An array or an
   * object is written as its JSON text. Returns false for a value with no such
   * form: a function, a symbol, or an object JSON can't serialize.
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

  /** Returns the bytes written, in an array of exactly their length. */
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

  /** The number of bytes left to read. */
  get left(): number {
    return this.bytes.length - this.at;
  }

  /** Throws unless at least `count` more bytes remain. */
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
   * Reads a count of items that each take at least `each` bytes. It is checked
   * against the remaining bytes before anything is allocated, so a damaged
   * count can't request an absurd allocation.
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
 * Writes rows `[0, count)` of a column. Returns the first row it couldn't
 * write, or -1. A `transient` field writes nothing.
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
 * Reads rows `[0, count)` of a column. A `transient` field reads nothing and
 * stays undefined. If a codec rejects a value, its error propagates.
 */
export const readColumn = (
  reader: Reader,
  kind: FieldKind,
  column: Column,
  count: number,
  codec?: RefCodec<unknown>,
  /** True for a snapshot older than format 3, whose ids are four bytes. */
  narrow = false
): void => {
  if (kind === "entity" && narrow) {
    const ids = new Uint32Array(count);
    reader.numbers(ids, count, 4);
    (column as Float64Array).set(ids);
    return;
  }
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

/** A snapshot whose bytes are not what a writer makes. @internal */
export const corrupt = (how: string): SnapshotError =>
  new SnapshotError("corrupt", `The snapshot is damaged: ${how}.`);
