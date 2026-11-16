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
import { add, addColumn, addColumnPerRow, finish, shapeOf } from "./hash";

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

// ---------------------------------------------------------------------------
// A snapshot read without the program's components
// ---------------------------------------------------------------------------

/** A component as a snapshot describes it: by name, with its fields. */
export interface SnapshotComponent {
  name: string;
  storage: "table" | "sparse";
  fields: { name: string; kind: FieldKind }[];
}

/** One table of a snapshot: the components its entities have, and their rows. */
export interface SnapshotTable {
  /** Names of the table's components. */
  components: string[];
  /** The id of the entity in each row. */
  entities: Uint32Array;
  /** Per component name, per field name: one value per row. */
  columns: Record<string, Record<string, Column>>;
}

/** One sparse component of a snapshot: who has it, and their values. */
export interface SnapshotSparse {
  component: string;
  /** The index (not the id) of each entity that has the component. */
  members: Uint32Array;
  /** Per field name: one value per member. */
  columns: Record<string, Column>;
}

/**
 * Everything a snapshot holds, read without knowing the program's
 * components: a snapshot describes its own. This is the form a migration
 * works on, to make an old save fit the components a game has now.
 *
 * A `json` field's column holds the plain data itself. A `ref` field's
 * column holds what its codec had made of each value. A `transient` field
 * has no column.
 */
export interface SnapshotContents {
  /** The random generator's four words. */
  random: Uint32Array;
  /** One generation per entity slot. */
  generations: Uint16Array;
  /** The freed slots, in the order they will be reused. */
  freed: number[];
  /** Every component the world knew, whether or not an entity had it. */
  components: SnapshotComponent[];
  /** In the order queries visit them. */
  tables: SnapshotTable[];
  sparse: SnapshotSparse[];
}

const columnOf = (kind: FieldKind, count: number): Column => {
  switch (kind) {
    case "f32": {
      return new Float32Array(count);
    }
    case "f64": {
      return new Float64Array(count);
    }
    case "i32": {
      return new Int32Array(count);
    }
    case "u32":
    case "entity": {
      return new Uint32Array(count);
    }
    case "u16": {
      return new Uint16Array(count);
    }
    case "u8": {
      return new Uint8Array(count);
    }
    default: {
      return Array.from({ length: count }, () => undefined);
    }
  }
};

const damaged = (how: string): SnapshotError =>
  new SnapshotError("corrupt", `The snapshot is damaged: ${how}.`);

/** Reads a snapshot into its contents. Needs no component definitions. */
export const readSnapshot = (bytes: Uint8Array): SnapshotContents => {
  const reader = new Reader(bytes);
  if (reader.left < 8 || reader.u32() !== MAGIC) {
    throw new SnapshotError(
      "not a snapshot",
      "These bytes are not a snapshot of a world."
    );
  }
  const format = reader.u32();
  if (format !== FORMAT) {
    throw new SnapshotError(
      "newer format",
      `The snapshot is in format ${format}, and this version reads format ${FORMAT}.`
    );
  }
  const random = new Uint32Array(4);
  for (let word = 0; word < 4; word++) {
    random[word] = reader.u32();
  }
  const generations = new Uint16Array(reader.count(2));
  reader.numbers(generations, generations.length, 2);
  const freed: number[] = [];
  for (let i = reader.count(4); i > 0; i--) {
    freed.push(reader.u32());
  }

  const components: SnapshotComponent[] = [];
  for (let c = reader.count(9); c > 0; c--) {
    const name = reader.text();
    const stored = reader.u8();
    if (stored > 1) {
      throw damaged(
        "a component is stored in a way this version does not know"
      );
    }
    const storage = stored === 1 ? "sparse" : "table";
    const fields: SnapshotComponent["fields"] = [];
    for (let f = reader.count(5); f > 0; f--) {
      const field = reader.text();
      const kind = KIND_CODES[reader.u8()];
      if (kind === undefined) {
        throw damaged("a field is of a kind this version does not know");
      }
      fields.push({ name: field, kind });
    }
    components.push({ name, storage, fields });
  }
  const componentAt = (): SnapshotComponent => {
    const component = components[reader.u32()];
    if (component === undefined) {
      throw damaged("it refers to a component it does not list");
    }
    return component;
  };
  const readFields = (
    component: SnapshotComponent,
    count: number
  ): Record<string, Column> => {
    const columns: Record<string, Column> = {};
    for (const { kind, name } of component.fields) {
      if (kind === "transient") {
        continue;
      }
      const column = columnOf(kind, count);
      // A ref field stays in its encoded form: there is no codec here.
      readColumn(reader, kind === "ref" ? "json" : kind, column, count);
      columns[name] = column;
    }
    return columns;
  };

  const tables: SnapshotTable[] = [];
  for (let t = reader.count(8); t > 0; t--) {
    const of: SnapshotComponent[] = [];
    for (let d = reader.count(4); d > 0; d--) {
      of.push(componentAt());
    }
    const entities = new Uint32Array(reader.count(4));
    reader.numbers(entities, entities.length, 4);
    const columns: SnapshotTable["columns"] = {};
    for (const component of of) {
      columns[component.name] = readFields(component, entities.length);
    }
    tables.push({
      components: of.map((component) => component.name),
      entities,
      columns,
    });
  }
  const sparse: SnapshotSparse[] = [];
  for (let s = reader.count(8); s > 0; s--) {
    const component = componentAt();
    const members = new Uint32Array(reader.count(4));
    reader.numbers(members, members.length, 4);
    sparse.push({
      component: component.name,
      members,
      columns: readFields(component, members.length),
    });
  }
  if (reader.left !== 4 || reader.u32() !== END) {
    throw damaged("it does not end where it should");
  }
  return { random, generations, freed, components, tables, sparse };
};

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Writes contents back into the bytes of a snapshot. What it is given has
 * to hang together: every component a table or a sparse set names is
 * listed, and every field that is saved has a column of one value per row.
 * `World.load` checks the rest when it reads the result.
 */
export const writeSnapshot = (contents: SnapshotContents): Uint8Array => {
  const components = contents.components.toSorted(byName);
  const indexOf = new Map<string, number>();
  for (const [index, component] of components.entries()) {
    if (indexOf.has(component.name)) {
      throw damaged(`it lists the component "${component.name}" twice`);
    }
    indexOf.set(component.name, index);
  }
  const named = (name: string): SnapshotComponent => {
    const index = indexOf.get(name);
    if (index === undefined) {
      throw damaged(`it holds data for "${name}", which it does not list`);
    }
    return components[index]!;
  };

  const writer = new Writer(1024);
  writer.u32(MAGIC);
  writer.u32(FORMAT);
  for (let word = 0; word < 4; word++) {
    writer.u32(contents.random[word] ?? 0);
  }
  writer.u32(contents.generations.length);
  writer.numbers(contents.generations, contents.generations.length, 2);
  writer.u32(contents.freed.length);
  for (const index of contents.freed) {
    writer.u32(index);
  }
  writer.u32(components.length);
  for (const component of components) {
    writer.text(component.name);
    writer.u8(component.storage === "sparse" ? 1 : 0);
    writer.u32(component.fields.length);
    for (const field of component.fields) {
      writer.text(field.name);
      writer.u8(KIND_CODES.indexOf(field.kind));
    }
  }
  const writeFields = (
    component: SnapshotComponent,
    columns: Record<string, Column> | undefined,
    count: number
  ): void => {
    for (const { kind, name } of component.fields) {
      if (kind === "transient") {
        continue;
      }
      const column = columns?.[name];
      if (column === undefined || column.length !== count) {
        throw damaged(
          `"${component.name}.${name}" has no column of ${count} values`
        );
      }
      const row = writeColumn(
        writer,
        kind === "ref" ? "json" : kind,
        column,
        count
      );
      if (row !== -1) {
        throw new SnapshotError(
          "cannot be saved",
          `"${component.name}.${name}" holds a value that is not plain data.`,
          component.name
        );
      }
    }
  };

  writer.u32(contents.tables.length);
  for (const table of contents.tables) {
    const of = table.components.map((name) => named(name)).toSorted(byName);
    writer.u32(of.length);
    for (const component of of) {
      writer.u32(indexOf.get(component.name)!);
    }
    writer.u32(table.entities.length);
    writer.numbers(table.entities, table.entities.length, 4);
    for (const component of of) {
      writeFields(
        component,
        table.columns[component.name],
        table.entities.length
      );
    }
  }
  const sets = contents.sparse
    .filter((set) => set.members.length > 0)
    .toSorted((a, b) => byName({ name: a.component }, { name: b.component }));
  writer.u32(sets.length);
  for (const set of sets) {
    writer.u32(indexOf.get(named(set.component).name)!);
    writer.u32(set.members.length);
    writer.numbers(set.members, set.members.length, 4);
    writeFields(named(set.component), set.columns, set.members.length);
  }
  writer.u32(END);
  return writer.finish();
};

/**
 * The hash of the world a snapshot's contents describe: the number
 * `World.hash` gives for the world the snapshot was taken from, worked out
 * from the contents alone, with none of the program's components.
 *
 * It is how a snapshot is checked against a hash recorded beside it when the
 * components that wrote it are gone, as before a migration: damage that
 * still reads as a snapshot gives another number. It follows `World.hash`
 * step for step, and a change to one is a change to the other.
 */
export const hashSnapshot = (contents: SnapshotContents): number => {
  const { freed, generations, tables } = contents;
  const known = new Map<
    string,
    { readonly component: SnapshotComponent; readonly shape: number }
  >();
  for (const component of contents.components) {
    known.set(component.name, {
      component,
      shape: shapeOf(
        component.name,
        component.fields.map((field) => field.name),
        component.fields.map((field) => field.kind)
      ),
    });
  }
  const named = (name: string) => {
    const found = known.get(name);
    if (found === undefined) {
      throw damaged(`it holds data for "${name}", which it does not list`);
    }
    return found;
  };
  const columnOf = (
    component: SnapshotComponent,
    columns: Record<string, Column> | undefined,
    field: string,
    count: number
  ): Column => {
    const column = columns?.[field];
    if (column === undefined || column.length !== count) {
      throw damaged(
        `"${component.name}.${field}" has no column of ${count} values`
      );
    }
    return column;
  };

  let alive = 0;
  for (const table of tables) {
    alive += table.entities.length;
  }
  let h = add(add(0, generations.length), alive);
  h = add(h, freed.length);
  for (const index of freed) {
    h = add(add(h, index), generations[index] ?? 0);
  }

  h = add(h, tables.length);
  for (const table of tables) {
    const of = table.components
      .map((name) => named(name))
      .toSorted((a, b) => byName(a.component, b.component));
    const count = table.entities.length;
    h = add(add(h, of.length), count);
    h = addColumn(h, "entity", table.entities, count);
    for (const { component, shape } of of) {
      h = add(h, shape);
      for (const { kind, name } of component.fields) {
        if (kind === "transient") {
          continue;
        }
        h = addColumn(
          h,
          // A ref field's column holds what its codec had made of each value.
          kind === "ref" ? "json" : kind,
          columnOf(component, table.columns[component.name], name, count),
          count
        );
      }
    }
  }

  const sets = contents.sparse
    .filter((set) => set.members.length > 0)
    .toSorted((a, b) => byName({ name: a.component }, { name: b.component }));
  for (const set of sets) {
    const { component, shape } = named(set.component);
    const count = set.members.length;
    const states = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      states[i] = add(shape, set.members[i]!);
    }
    for (const { kind, name } of component.fields) {
      if (kind === "transient") {
        continue;
      }
      addColumnPerRow(
        states,
        kind === "ref" ? "json" : kind,
        columnOf(component, set.columns, name, count),
        count
      );
    }
    let members = 0;
    for (let i = 0; i < count; i++) {
      members = (members + finish(states[i]!)) | 0;
    }
    h = add(add(add(h, shape), count), members);
  }

  const { random } = contents;
  for (let word = 0; word < 4; word++) {
    h = add(h, random[word] ?? 0);
  }
  return finish(h);
};
