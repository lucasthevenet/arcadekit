/**
 * The format of a world's snapshot: what it holds, and in what order. It is
 * written in one place, `write`, and read in one, `read`, whoever holds what
 * a snapshot holds: a world, with the program's components, or contents held
 * apart from any world, for a migration. `snapshot.ts` is the encoding of
 * each part.
 *
 * A snapshot is its magic number and the number of its format, the random
 * generator's four words, a generation for every entity slot and the freed
 * slots, the components it names, the singletons that were written, what
 * the world's stores held, the tables, the sparse sets, and four bytes that
 * say it is whole.
 *
 * No Effect dependency.
 */
import type { Column } from "./column";
import type { FieldKind, RefCodec } from "./component";
import {
  END,
  FORMAT,
  KIND_CODES,
  MAGIC,
  Reader,
  SnapshotError,
  Writer,
  corrupt,
  readColumn,
  writeColumn,
} from "./snapshot";
import { describeValue } from "./store";

/** One column for each field of a component, by the field's name. */
type Columns = Record<string, Column>;

/**
 * A component as the format needs it: its name and its fields, each with its
 * kind and, where the program defines the component, the codec of a `ref`
 * field. A `ComponentDef` is one. Without a codec, a `ref` field is read and
 * written in its encoded form.
 *
 * @internal
 */
export interface Shape {
  readonly name: string;
  readonly fields: readonly string[];
  readonly kinds: readonly FieldKind[];
  readonly codecs?: readonly (RefCodec<unknown> | undefined)[];
}

/**
 * What one store of a world held, as a snapshot keeps it. A store is state
 * that a world keeps for its owner beside its components, such as an app's
 * queued actions and waiting events.
 *
 * @category Models
 */
export interface SnapshotStore {
  /** The store's name, unique among the world's stores. */
  name: string;
  /** What it held, as plain data, in a form that is the store's own. */
  data: unknown;
}

/**
 * Where a table of a snapshot is read into.
 *
 * @internal
 */
export interface TableTarget<C> {
  /** Where the id of the entity in each row goes: at least as long as the table. */
  readonly entities: Float64Array;
  /** The ids have been read: the place to check them. */
  placed(): void;
  /** Where a component's fields go. Asked for once the ids are placed. */
  columns(component: C): Columns;
}

/**
 * Where a sparse set of a snapshot is read into.
 *
 * @internal
 */
export interface SparseTarget {
  /** Where the index of each member goes. */
  readonly members: Uint32Array;
  /** The members have been read: the place to check them. */
  placed(): void;
  /** Where the component's fields go. Asked for once the members are placed. */
  columns(): Columns;
}

/**
 * Where a snapshot is read into: `read` calls these in the order the format
 * holds what they take, whatever the format's version, and fills what they
 * return. `C` is what the target keeps of a component.
 *
 * A target trusts nothing it is given: a count has been checked against the
 * bytes that are left, and nothing else has.
 *
 * @internal
 */
export interface Target<C extends Shape> {
  /** Where the random generator's four words go. */
  readonly random: Uint32Array;
  /** Makes room for a number of entity slots, and returns where their generations go. */
  slots(count: number): Uint32Array;
  /** The freed slots, in the order they will be reused. The generations have been read. */
  freed(indexes: readonly number[]): void;
  /**
   * A component the snapshot lists, as it describes it: how it is stored, as
   * the byte written for it, and its fields. The kind of a field is undefined
   * when its byte is of no kind this version knows.
   */
  component(
    name: string,
    storage: number,
    fields: readonly string[],
    kinds: readonly (FieldKind | undefined)[]
  ): C;
  /** Where a singleton's one row goes. */
  singleton(component: C): Columns;
  /** What the stores held, as the snapshot lists them. Empty before format 4. */
  stores(stores: SnapshotStore[]): void;
  table(components: readonly C[], count: number): TableTarget<C>;
  /** Every table has been read. */
  tabled(): void;
  sparse(component: C, count: number): SparseTarget;
  /** The snapshot ended where it should. */
  end(): void;
}

/** Reads a component's fields into its columns, naming the field a codec refuses. */
const readFields = (
  reader: Reader,
  shape: Shape,
  columns: Columns,
  count: number,
  narrow: boolean
): void => {
  const { codecs, fields, kinds } = shape;
  for (let f = 0; f < fields.length; f++) {
    const kind = kinds[f]!;
    if (kind === "transient") {
      continue;
    }
    const field = fields[f]!;
    const codec = codecs?.[f];
    try {
      readColumn(
        reader,
        // Without its codec, a ref field stays in its encoded form.
        kind === "ref" && codec === undefined ? "json" : kind,
        columns[field]!,
        count,
        codec,
        narrow
      );
    } catch (error) {
      if (error instanceof SnapshotError) {
        throw error;
      }
      throw new SnapshotError(
        "component changed",
        `"${shape.name}.${field}" has a codec that refuses a value the snapshot holds: ${error instanceof Error ? error.message : String(error)}`,
        shape.name
      );
    }
  }
};

/**
 * Reads a snapshot into a target. Every failure is a `SnapshotError`.
 *
 * With `early`, it stops once the singletons are read if the snapshot holds
 * them before its tables, as format 4 does: `end` is then not called.
 *
 * @internal
 */
export const read = <C extends Shape>(
  bytes: Uint8Array,
  target: Target<C>,
  early = false
): void => {
  const reader = new Reader(bytes);
  if (reader.left < 8 || reader.u32() !== MAGIC) {
    throw new SnapshotError(
      "not a snapshot",
      "These bytes are not a snapshot of a world."
    );
  }
  const format = reader.u32();
  if (format < 1 || format > FORMAT) {
    throw new SnapshotError(
      "newer format",
      `The snapshot is in format ${format}, and this version reads formats 1 to ${FORMAT}.`
    );
  }
  const { random } = target;
  for (let word = 0; word < 4; word++) {
    random[word] = reader.u32();
  }

  // Format 3 widened an entity's id: a generation is four bytes where it
  // was two, and an id, in a table or in a field, eight where it was four.
  // An id of the older formats is the same number, in a narrower place.
  const narrow = format < 3;
  const slots = reader.count(narrow ? 2 : 4);
  const generations = target.slots(slots);
  if (narrow) {
    const read = new Uint16Array(slots);
    reader.numbers(read, slots, 2);
    generations.set(read);
  } else {
    reader.numbers(generations, slots, 4);
  }
  const freed: number[] = [];
  for (let i = reader.count(4); i > 0; i--) {
    freed.push(reader.u32());
  }
  target.freed(freed);

  const named: C[] = [];
  for (let c = reader.count(9); c > 0; c--) {
    const name = reader.text();
    const storage = reader.u8();
    const fields: string[] = [];
    const kinds: (FieldKind | undefined)[] = [];
    for (let f = reader.count(5); f > 0; f--) {
      fields.push(reader.text());
      kinds.push(KIND_CODES[reader.u8()]);
    }
    named.push(target.component(name, storage, fields, kinds));
  }
  const componentAt = (): C => {
    const component = named[reader.u32()];
    if (component === undefined) {
      throw corrupt("it refers to a component it does not list");
    }
    return component;
  };

  const readSingletons = (): void => {
    // Format 1 had no singletons.
    for (let s = format >= 2 ? reader.count(4) : 0; s > 0; s--) {
      const component = componentAt();
      readFields(reader, component, target.singleton(component), 1, narrow);
    }
  };
  // Format 4 holds the singletons and the stores before the tables, so that
  // a reader looking for one stops short of the entities.
  const stores: SnapshotStore[] = [];
  if (format >= 4) {
    readSingletons();
    for (let s = reader.count(5); s > 0; s--) {
      stores.push({ name: reader.text(), data: reader.value() });
    }
  }
  target.stores(stores);
  if (early && format >= 4) {
    return;
  }

  for (let t = reader.count(8); t > 0; t--) {
    const of: C[] = [];
    for (let d = reader.count(4); d > 0; d--) {
      of.push(componentAt());
    }
    const count = reader.count(narrow ? 4 : 8);
    const table = target.table(of, count);
    if (narrow) {
      const ids = new Uint32Array(count);
      reader.numbers(ids, count, 4);
      table.entities.set(ids);
    } else {
      reader.numbers(table.entities, count, 8);
    }
    table.placed();
    // The same order the fields were written in: components by name.
    for (const component of of) {
      readFields(reader, component, table.columns(component), count, narrow);
    }
  }
  target.tabled();

  for (let s = reader.count(8); s > 0; s--) {
    const component = componentAt();
    const count = reader.count(4);
    const set = target.sparse(component, count);
    reader.numbers(set.members, count, 4);
    set.placed();
    readFields(reader, component, set.columns(), count, narrow);
  }
  if (format < 4) {
    readSingletons();
  }
  if (reader.left !== 4 || reader.u32() !== END) {
    throw corrupt("it does not end where it should");
  }
  target.end();
};

/**
 * A table to write: its components in order of name, and its rows.
 *
 * @internal
 */
export interface TableSource<C> {
  readonly components: readonly C[];
  /** The number of rows. */
  readonly count: number;
  /** The id of the entity in each row, in its first `count` elements. */
  readonly entities: Float64Array;
}

/**
 * A sparse set to write: its members, and their values.
 *
 * @internal
 */
export interface SparseSource<C> {
  readonly component: C;
  readonly count: number;
  /** The index of each member, in its first `count` elements. */
  readonly members: Uint32Array;
  readonly columns: Columns;
}

/**
 * What a snapshot is written from: `write` takes these in the order the
 * format holds them. `C` is what the source keeps of a component, and `T`
 * of a table: a world's own tables are written as they are, with nothing
 * made for each.
 *
 * @internal
 */
export interface Source<
  C extends Shape,
  T extends TableSource<C> = TableSource<C>,
> {
  /** About how many bytes it will take, to allocate at once. */
  readonly estimate: number;
  /** The random generator's four words. */
  readonly random: ArrayLike<number>;
  /** One generation per entity slot, in its first `slots` elements. */
  readonly generations: Uint32Array;
  readonly slots: number;
  /** The freed slots, in the order they will be reused. */
  readonly freed: readonly number[];
  /** Every component the rest names, once each, in order of name. */
  readonly components: readonly C[];
  /** How a component is stored, as its place in `STORAGES`. */
  storage(component: C): number;
  /** The singletons that were written, in order of name, each one row. */
  readonly singletons: readonly {
    readonly component: C;
    readonly columns: Columns;
  }[];
  /** What the stores hold, the ones that hold anything, in order of name. */
  readonly stores: readonly SnapshotStore[];
  /** In the order queries visit them, the empty ones too. */
  readonly tables: readonly T[];
  /** A component's columns in a table, each with as many values as it has rows, at least. */
  columns(table: T, component: C): Columns;
  /** The sets that have a member, in order of name. */
  readonly sparse: readonly SparseSource<C>[];
}

/** Writes rows `[0, count)` of a component's fields, naming the field that can't be. */
const writeFields = (
  writer: Writer,
  shape: Shape,
  columns: Columns,
  count: number
): void => {
  const { codecs, fields, kinds } = shape;
  for (let f = 0; f < fields.length; f++) {
    const kind = kinds[f]!;
    const field = fields[f]!;
    const codec = codecs?.[f];
    if (kind === "transient") {
      continue;
    }
    const column = columns[field]!;
    const row = writeColumn(
      writer,
      // Without its codec, a ref field is in its encoded form already.
      kind === "ref" && codec === undefined ? "json" : kind,
      column,
      count,
      codec
    );
    if (row !== -1) {
      throw new SnapshotError(
        "cannot be saved",
        kind === "ref" && codec !== undefined
          ? `"${shape.name}.${field}" holds a value its codec did not turn into plain data (${describeValue(column[row])}).`
          : `"${shape.name}.${field}" holds a value that is not plain data (${describeValue(column[row])}). A json field holds text, numbers, booleans, bigints, null and undefined, and arrays and objects of text, numbers, booleans and null. Give the field a codec with Field.ref, or make it Field.transient if it is not to be saved.`,
        shape.name
      );
    }
  }
};

/**
 * Writes a snapshot from a source, in the current format.
 *
 * @internal
 */
export const write = <C extends Shape, T extends TableSource<C>>(
  source: Source<C, T>
): Uint8Array => {
  const writer = new Writer(source.estimate);
  writer.u32(MAGIC);
  writer.u32(FORMAT);
  for (let word = 0; word < 4; word++) {
    writer.u32(source.random[word] ?? 0);
  }

  // Every slot's generation, and the freed slots in the order they will be
  // handed out again.
  writer.u32(source.slots);
  writer.numbers(source.generations, source.slots, 4);
  writer.u32(source.freed.length);
  for (const index of source.freed) {
    writer.u32(index);
  }

  const { components } = source;
  const indexOf = new Map<C, number>();
  writer.u32(components.length);
  for (let c = 0; c < components.length; c++) {
    const component = components[c]!;
    indexOf.set(component, c);
    writer.text(component.name);
    writer.u8(source.storage(component));
    writer.u32(component.fields.length);
    for (let f = 0; f < component.fields.length; f++) {
      writer.text(component.fields[f]!);
      writer.u8(KIND_CODES.indexOf(component.kinds[f]!));
    }
  }

  // The singletons, each one row, and what each store holds: before the
  // tables, so that a reader looking for one stops short of the entities.
  writer.u32(source.singletons.length);
  for (const single of source.singletons) {
    writer.u32(indexOf.get(single.component)!);
    writeFields(writer, single.component, single.columns, 1);
  }
  writer.u32(source.stores.length);
  for (const store of source.stores) {
    writer.text(store.name);
    if (!writer.value(store.data)) {
      throw new SnapshotError(
        "cannot be saved",
        `The store "${store.name}" gave a snapshot what is not plain data (${describeValue(store.data)}).`
      );
    }
  }

  // Tables in creation order: where a table stands decides where its
  // entities are visited.
  writer.u32(source.tables.length);
  for (const table of source.tables) {
    const { count } = table;
    writer.u32(table.components.length);
    for (const component of table.components) {
      writer.u32(indexOf.get(component)!);
    }
    writer.u32(count);
    writer.numbers(table.entities, count, 8);
    for (const component of table.components) {
      writeFields(writer, component, source.columns(table, component), count);
    }
  }

  writer.u32(source.sparse.length);
  for (const set of source.sparse) {
    writer.u32(indexOf.get(set.component)!);
    writer.u32(set.count);
    writer.numbers(set.members, set.count, 4);
    writeFields(writer, set.component, set.columns, set.count);
  }
  writer.u32(END);
  return writer.finish();
};
