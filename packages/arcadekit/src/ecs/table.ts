/**
 * Where component data is kept: a table per set of table components, a sparse
 * set per sparse component, and for each relation an index of who points at
 * whom. `World` owns them, and a `QueryView` reads them.
 *
 * No Effect dependency.
 */
import { growColumn, makeColumn } from "./column.ts";
import type { Column } from "./column.ts";
import { entityIndex, entityOf, idOf, isBoxed } from "./component.ts";
import type { ComponentDef, Entity } from "./component.ts";
import { refuseUnsaved } from "./format.ts";

/** A component's columns, by field. @internal */
export type Columns = Record<string, Column>;

/**
 * The world's version. A table, a sparse set, a relation index or a singleton
 * notes it when it is changed, or handed out to be written. Whatever keeps
 * something of the world (a moment, a cached hash) takes the version and moves
 * it on first, so what is changed later has a later version.
 * @internal
 */
export interface Versions {
  now: number;
}

/**
 * A table as a moment holds it: copies of its rows, which are never written,
 * so a later moment shares those that did not change. @internal
 */
export interface Kept {
  readonly table: Table;
  readonly count: number;
  readonly entities: Float64Array;
  /** By component id. A `transient` field has no copy. */
  readonly columns: readonly (Readonly<Record<string, Column>> | undefined)[];
}

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

/**
 * Where a world finds a table by its components: one step per component id,
 * in order of id. A step is no table, so finding one makes none.
 * @internal
 */
export interface TableNode {
  table: Table | undefined;
  readonly next: Map<number, TableNode>;
}

/** @internal */
export const tableNode = (): TableNode => ({
  table: undefined,
  next: new Map(),
});

/**
 * The node of the table of these components, sorted by id, with the steps
 * to it made as needed. A key of text, the ids joined, measured a tenth
 * slower on a spawn.
 * @internal
 */
export const nodeOf = (
  root: TableNode,
  sorted: readonly ComponentDef[]
): TableNode => {
  let node = root;
  for (let d = 0; d < sorted.length; d++) {
    const id = sorted[d]!.id;
    let step = node.next.get(id);
    if (step === undefined) {
      step = tableNode();
      node.next.set(id, step);
    }
    node = step;
  }
  return node;
};

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

  /** The version when a row was last pushed or removed. */
  shaped = 0;
  /** By component id: the version when its columns were last handed out to be written. */
  readonly versions: number[] = [];
  /** The last copy a moment took, and the version it was taken at. */
  kept: Kept | undefined;
  keptAt = -1;
  /** By component id: the hash of its columns, and the version it was taken at. */
  readonly hashes: number[] = [];
  readonly hashedAt: number[] = [];
  entitiesHash = 0;
  entitiesHashedAt = -1;

  /** Its components as a snapshot lists them, in order of name. */
  get components(): readonly ComponentDef[] {
    return this.defsByName;
  }

  constructor(
    readonly index: number,
    readonly defs: readonly ComponentDef[],
    readonly version: Versions,
    capacity = 16
  ) {
    this.capacity = capacity;
    this.entities = new Float64Array(capacity);
    this.defsByName = defs.toSorted(byName);
    for (const def of defs) {
      this.ids.add(def.id);
      this.columns[def.id] = makeColumns(def, capacity);
      this.versions[def.id] = 0;
      this.hashedAt[def.id] = -1;
      this.hashes[def.id] = 0;
    }
  }

  /** The version when a component's rows last changed, by a write or a move. */
  changedAt(id: number): number {
    const written = this.versions[id]!;
    return written > this.shaped ? written : this.shaped;
  }

  /**
   * Puts back the columns of a moment that changed since `since`, so that it
   * holds the moment's rows again. A `transient` field of a component that is
   * put back is left `undefined`, and one of a component that is not keeps
   * its values.
   */
  putBack(kept: Kept, since: number): void {
    const now = this.version.now;
    const was = this.count;
    const { count } = kept;
    if (this.shaped > since) {
      this.entities.set(kept.entities);
      this.count = count;
    }
    for (const def of this.defs) {
      const id = def.id;
      const cols = this.columns[id]!;
      const restore = this.changedAt(id) > since;
      for (let f = 0; f < def.fields.length; f++) {
        const kind = def.kinds[f]!;
        const col = cols[def.fields[f]!]!;
        if (!restore) {
          continue;
        }
        if (kind === "transient") {
          (col as unknown[]).fill(undefined, 0, Math.max(was, count));
        } else {
          const from = kept.columns[id]![def.fields[f]!]!;
          if (isBoxed(kind)) {
            const to = col as unknown[];
            for (let r = 0; r < count; r++) {
              to[r] = from[r];
            }
            to.fill(undefined, count, Math.max(was, count));
          } else {
            (col as Float32Array).set(from as Float32Array);
          }
        }
      }
      if (restore) {
        this.versions[id] = now;
      }
    }
    if (this.shaped > since) {
      this.shaped = now;
    }
    this.kept = kept;
    this.keptAt = now;
  }

  /** What a moment keeps of it, sharing what has not changed since the last. */
  keep(at: number): Kept {
    const last = this.kept;
    const since = last === undefined ? -1 : this.keptAt;
    const { count, defs } = this;
    let clean = last !== undefined && this.shaped <= since;
    if (clean) {
      for (const def of defs) {
        if (this.versions[def.id]! > since) {
          clean = false;
          break;
        }
      }
    }
    if (clean && last !== undefined) {
      this.keptAt = at;
      return last;
    }
    const columns: (Record<string, Column> | undefined)[] = [];
    for (const def of defs) {
      const id = def.id;
      if (last !== undefined && this.changedAt(id) <= since) {
        columns[id] = last.columns[id];
        continue;
      }
      const cols = this.columns[id]!;
      refuseUnsaved(def, cols, count);
      const copy: Record<string, Column> = {};
      for (let f = 0; f < def.fields.length; f++) {
        if (def.kinds[f] !== "transient") {
          const name = def.fields[f]!;
          copy[name] = cols[name]!.slice(0, count);
        }
      }
      columns[id] = copy;
    }
    const entities =
      last !== undefined && this.shaped <= since
        ? last.entities
        : this.entities.slice(0, count);
    const kept = { table: this, count, entities, columns };
    this.kept = kept;
    this.keptAt = at;
    return kept;
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
    this.entities[this.count] = idOf(entity);
    this.shaped = this.version.now;
    return this.count++;
  }

  /** Removes a row by moving the last row into it. Returns the entity that moved, if any. */
  swapRemove(row: number): Entity | undefined {
    const last = this.count - 1;
    let moved: Entity | undefined;
    if (row !== last) {
      moved = entityOf(this.entities[last]!);
      this.entities[row] = idOf(moved);
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
    this.shaped = this.version.now;
    return moved;
  }
}

// ---------------------------------------------------------------------------
// Sparse set (one per sparse component)
// ---------------------------------------------------------------------------

/** A sparse set as a moment holds it. @internal */
export interface KeptSet {
  readonly set: SparseSet;
  readonly count: number;
  readonly members: Uint32Array;
  readonly columns: Readonly<Record<string, Column>>;
}

/** @internal */
export class SparseSet {
  dense: Uint32Array;
  sparse: Int32Array;
  count = 0;
  readonly columns: Columns;
  /** The version when a member last joined or left, or its columns were handed out to be written. */
  changed = 0;
  kept: KeptSet | undefined;
  keptAt = -1;
  hash = 0;
  hashedAt = -1;

  constructor(
    readonly def: ComponentDef,
    readonly version: Versions,
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
  readonly indexOf = (entity: Entity): number =>
    this.sparse[entityIndex(entity)]!;

  add(
    index: number,
    value: Readonly<Record<string, unknown>> | undefined
  ): void {
    this.changed = this.version.now;
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

  /**
   * Puts back what a moment kept of it, or empties it when the moment had
   * none. Its `transient` fields are left `undefined`.
   */
  putBack(kept: KeptSet | undefined): void {
    const { def, dense, sparse } = this;
    for (let i = 0; i < this.count; i++) {
      sparse[dense[i]!] = -1;
    }
    const was = this.count;
    const count = kept?.count ?? 0;
    if (kept !== undefined) {
      dense.set(kept.members);
      for (let i = 0; i < count; i++) {
        sparse[kept.members[i]!] = i;
      }
    }
    for (let f = 0; f < def.fields.length; f++) {
      const kind = def.kinds[f]!;
      const name = def.fields[f]!;
      const col = this.columns[name]!;
      if (kind === "transient") {
        (col as unknown[]).fill(undefined, 0, Math.max(was, count));
      } else if (isBoxed(kind)) {
        const to = col as unknown[];
        const from = kept?.columns[name];
        for (let r = 0; r < count; r++) {
          to[r] = from?.[r];
        }
        to.fill(undefined, count, Math.max(was, count));
      } else if (kept !== undefined) {
        (col as Float32Array).set(kept.columns[name] as Float32Array);
      }
    }
    this.count = count;
    this.changed = this.version.now;
    this.kept = kept;
    this.keptAt = this.version.now;
  }

  /** What a moment keeps of it: the last copy, when nothing changed since. */
  keep(at: number): KeptSet {
    let kept = this.kept;
    if (kept === undefined || this.changed > this.keptAt) {
      const { count, def } = this;
      refuseUnsaved(def, this.columns, count);
      const columns: Record<string, Column> = {};
      for (let f = 0; f < def.fields.length; f++) {
        if (def.kinds[f] !== "transient") {
          const name = def.fields[f]!;
          columns[name] = this.columns[name]!.slice(0, count);
        }
      }
      kept = { set: this, count, members: this.dense.slice(0, count), columns };
      this.kept = kept;
    }
    this.keptAt = at;
    return kept;
  }

  remove(index: number): boolean {
    if (!this.has(index)) {
      return false;
    }
    this.changed = this.version.now;
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
  /** The version when a link was last made or undone. */
  changed = 0;

  constructor(
    readonly def: ComponentDef,
    readonly version: Versions,
    size: number
  ) {
    this.head = new Int32Array(size).fill(-1);
    this.next = new Int32Array(size).fill(-1);
    this.prev = new Int32Array(size).fill(-1);
    this.target = new Int32Array(size).fill(-1);
  }

  /** Points nobody at anyone. */
  clear(): void {
    this.changed = this.version.now;
    this.head.fill(-1);
    this.next.fill(-1);
    this.prev.fill(-1);
    this.target.fill(-1);
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
    this.changed = this.version.now;
    this.unlink(source);
    const first = this.head[target]!;
    this.next[source] = first;
    if (first !== -1) {
      this.prev[first] = source;
    }
    this.head[target] = source;
    this.target[source] = target;
  }

  /** Returns whether anyone points at `target`. */
  pointedAt(target: number): boolean {
    return this.head[target] !== -1;
  }

  /** Makes `source` point at nothing. */
  unlink(source: number): void {
    const target = this.target[source]!;
    if (target === -1) {
      return;
    }
    this.changed = this.version.now;
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

  /**
   * Writes the indexes of the entities that point at `target` into
   * `members`, in no order, growing its array if it must, and returns how
   * many.
   */
  collect(
    target: number,
    members: { dense: Uint32Array; count: number }
  ): number {
    let { dense } = members;
    let count = 0;
    for (let at = this.head[target]!; at !== -1; at = this.next[at]!) {
      if (count === dense.length) {
        const grown = new Uint32Array(dense.length * 2);
        grown.set(dense);
        dense = members.dense = grown;
      }
      dense[count++] = at;
    }
    members.count = count;
    return count;
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
