/**
 * Where component data is kept: a table per set of table components, a sparse
 * set per sparse component, and for each relation an index of who points at
 * whom. `World` owns them, and a `QueryView` reads them.
 *
 * No Effect dependency.
 */
import { INDEX_MASK, growColumn, isBoxed, makeColumn } from "./component";
import type { Column, ComponentDef, Entity } from "./component";

/** A component's columns, by field. @internal */
export type Columns = Record<string, Column>;

/** @internal */
export const makeColumns = (def: ComponentDef, capacity: number): Columns => {
  const cols: Columns = {};
  for (let f = 0; f < def.fields.length; f++) {
    cols[def.fields[f]!] = makeColumn(def.kinds[f]!, capacity);
  }
  return cols;
};

/** @internal */
export const growColumns = (
  def: ComponentDef,
  cols: Columns,
  capacity: number
): void => {
  for (let f = 0; f < def.fields.length; f++) {
    const name = def.fields[f];
    cols[name!] = growColumn(def.kinds[f]!, cols[name!]!, capacity);
  }
};

/** Writes one row of a component, a number that isn't given as 0. @internal */
export const writeRow = (
  def: ComponentDef,
  cols: Columns,
  row: number,
  value: Readonly<Record<string, unknown>> | undefined
): void => {
  // A bare component is its initial value, when it says one.
  const from = value ?? def.initial;
  for (let f = 0; f < def.fields.length; f++) {
    const name = def.fields[f];
    // A number that is not given is 0, whether the whole value was left
    // out or the one field, which JavaScript and a cast allow: written as
    // it came, an undefined would be NaN in a column of floats.
    const given = from === undefined ? undefined : from[name!];
    cols[name!]![row] =
      given === undefined && !isBoxed(def.kinds[f]!) ? 0 : given;
  }
};

/** Reads one row of a component as an object. @internal */
export const readRow = (
  def: ComponentDef,
  cols: Columns,
  row: number
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (let f = 0; f < def.fields.length; f++) {
    const name = def.fields[f];
    out[name!] = cols[name!]![row];
  }
  return out;
};

/**
 * Orders by name, by UTF-16 code unit: the same in every engine and locale.
 * @internal
 */
export const byName = (
  a: { readonly name: string },
  b: { readonly name: string }
) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// ---------------------------------------------------------------------------
// Table (one archetype)
// ---------------------------------------------------------------------------

/** @internal */
export class Table {
  /** The id of the entity in each row. */
  entities: Float64Array;
  count = 0;
  capacity: number;
  /** Indexed by component id. The record identity is stable; its arrays are replaced on growth. */
  readonly columns: (Columns | undefined)[] = [];
  readonly ids: Set<number> = new Set();
  readonly addEdges: Map<number, Table> = new Map();
  readonly removeEdges: Map<number, Table> = new Map();
  /**
   * The table's components in order of name. `defs` is in order of id, which
   * depends on the order the program happened to define its components in.
   */
  readonly defsByName: readonly ComponentDef[];

  constructor(
    readonly index: number,
    readonly defs: readonly ComponentDef[],
    capacity = 16
  ) {
    this.capacity = capacity;
    this.entities = new Float64Array(capacity);
    this.defsByName = defs.toSorted(byName);
    for (const def of defs) {
      this.ids.add(def.id);
      this.columns[def.id] = makeColumns(def, capacity);
    }
  }

  /** Appends a row. The caller must write every component of the new row. */
  push(entity: Entity): number {
    if (this.count === this.capacity) {
      const capacity = this.capacity * 2;
      const entities = new Float64Array(capacity);
      entities.set(this.entities);
      this.entities = entities;
      for (const def of this.defs) {
        growColumns(def, this.columns[def.id]!, capacity);
      }
      this.capacity = capacity;
    }
    this.entities[this.count] = entity;
    return this.count++;
  }

  /** Removes a row by moving the last row into it. Returns the entity that moved, if any. */
  swapRemove(row: number): Entity | undefined {
    const last = this.count - 1;
    let moved: Entity | undefined;
    if (row !== last) {
      moved = this.entities[last] as Entity;
      this.entities[row] = moved;
    }
    for (const def of this.defs) {
      const cols = this.columns[def.id]!;
      for (let f = 0; f < def.fields.length; f++) {
        const col = cols[def.fields[f]!]!;
        if (row !== last) {
          col[row] = col[last];
        }
        if (isBoxed(def.kinds[f]!)) {
          col[last] = undefined;
        }
      }
    }
    this.count = last;
    return moved;
  }
}

// ---------------------------------------------------------------------------
// Sparse set (one per sparse component)
// ---------------------------------------------------------------------------

/** @internal */
export class SparseSet {
  dense: Uint32Array;
  sparse: Int32Array;
  count = 0;
  readonly columns: Columns;

  constructor(
    readonly def: ComponentDef,
    capacity = 16
  ) {
    this.dense = new Uint32Array(capacity);
    this.sparse = new Int32Array(64).fill(-1);
    this.columns = makeColumns(def, capacity);
  }

  has(index: number): boolean {
    return index < this.sparse.length && this.sparse[index] !== -1;
  }

  /** The row of an entity in `columns`. An arrow function, so it survives destructuring. */
  readonly indexOf = (entity: number): number =>
    this.sparse[entity & INDEX_MASK]!;

  add(
    index: number,
    value: Readonly<Record<string, unknown>> | undefined
  ): void {
    if (index >= this.sparse.length) {
      let size = this.sparse.length;
      while (size <= index) {
        size *= 2;
      }
      const sparse = new Int32Array(size).fill(-1);
      sparse.set(this.sparse);
      this.sparse = sparse;
    }
    let pos = this.sparse[index];
    if (pos === -1) {
      if (this.count === this.dense.length) {
        const capacity = this.dense.length * 2;
        const dense = new Uint32Array(capacity);
        dense.set(this.dense);
        this.dense = dense;
        growColumns(this.def, this.columns, capacity);
      }
      pos = this.count++;
      this.dense[pos] = index;
      this.sparse[index] = pos;
      writeRow(this.def, this.columns, pos, value);
    } else if (value !== undefined) {
      writeRow(this.def, this.columns, pos!, value);
    }
  }

  remove(index: number): boolean {
    if (!this.has(index)) {
      return false;
    }
    const pos = this.sparse[index]!;
    const last = this.count - 1;
    const { def } = this;
    if (pos !== last) {
      const movedIndex = this.dense[last]!;
      this.dense[pos] = movedIndex;
      this.sparse[movedIndex] = pos;
    }
    for (let f = 0; f < def.fields.length; f++) {
      const col = this.columns[def.fields[f]!]!;
      if (pos !== last) {
        col[pos] = col[last];
      }
      if (isBoxed(def.kinds[f]!)) {
        col[last] = undefined;
      }
    }
    this.sparse[index] = -1;
    this.count = last;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Relations (one index per relation: who points at whom)
// ---------------------------------------------------------------------------

/**
 * For one relation, the entities that point at each target: a linked list
 * per target, threaded through arrays indexed by entity index. Linking and
 * unlinking are a few assignments; finding who points at an entity does
 * not look at anyone else.
 *
 * It is worked out from the relation's own columns, which are what is
 * saved and hashed: a world that loads a snapshot builds it again. The
 * order within a list depends on the order relations were made in, so
 * whoever reads a list sorts it.
 * @internal
 */
export class RelationIndex {
  /** For each target index, one entity that points at it, or -1. */
  private head: Int32Array;
  /** For each source index, the next and the previous source of the same target, or -1. */
  private next: Int32Array;
  private prev: Int32Array;
  /** For each source index, the target it points at, or -1. */
  private target: Int32Array;

  constructor(
    readonly def: ComponentDef,
    size: number
  ) {
    this.head = new Int32Array(size).fill(-1);
    this.next = new Int32Array(size).fill(-1);
    this.prev = new Int32Array(size).fill(-1);
    this.target = new Int32Array(size).fill(-1);
  }

  /** Makes room for `size` entities. */
  grow(size: number): void {
    for (const name of ["head", "next", "prev", "target"] as const) {
      const grown = new Int32Array(size).fill(-1);
      grown.set(this[name]);
      this[name] = grown;
    }
  }

  /** Makes `source` point at `target`, and at nothing else. */
  link(source: number, target: number): void {
    this.unlink(source);
    const first = this.head[target]!;
    this.next[source] = first;
    if (first !== -1) {
      this.prev[first] = source;
    }
    this.head[target] = source;
    this.target[source] = target;
  }

  /** Makes `source` point at nothing. */
  unlink(source: number): void {
    const target = this.target[source]!;
    if (target === -1) {
      return;
    }
    const next = this.next[source]!;
    const prev = this.prev[source]!;
    if (prev === -1) {
      this.head[target] = next;
    } else {
      this.next[prev] = next;
    }
    if (next !== -1) {
      this.prev[next] = prev;
    }
    this.next[source] = -1;
    this.prev[source] = -1;
    this.target[source] = -1;
  }

  /** Returns the indexes of the entities that point at `target`, ascending. */
  sources(target: number): number[] {
    const out: number[] = [];
    for (let at = this.head[target]!; at !== -1; at = this.next[at]!) {
      out.push(at);
    }
    return out.sort((a, b) => a - b);
  }
}
