/**
 * Archetype storage core.
 *
 * - Entities with the same set of table components live together in a Table,
 *   one column per field (typed arrays for numeric fields).
 * - Components declared with `storage: "sparse"` live in their own sparse set,
 *   so adding/removing them never moves an entity between tables. Queries can
 *   require them, exclude them, and read their data.
 * - Iteration order is always the same: tables in creation order, rows
 *   ascending. It does not depend on how the matching rows were found.
 * - Queries cache the tables they match and only look at tables created since
 *   the last time they ran.
 * - Structural changes (spawn/despawn/add/remove) are not allowed while a
 *   query is iterating. Queue them on a CommandBuffer instead.
 * - A world owns a seeded random number generator, so its state is part of
 *   the world.
 *
 * No Effect dependency.
 */
import {
  entityGeneration,
  entityIndex,
  GENERATION_MASK,
  growColumn,
  INDEX_MASK,
  isComponentDef,
  makeColumn,
  makeEntity,
} from "./component";
import type {
  Accessor,
  Column,
  ColumnsOf,
  ComponentDef,
  ComponentInput,
  Entity,
  Schema,
  ValueOf,
} from "./component";
import { Rng } from "./random";

const NOT_PLACED = -1;
const FREE = -2;

type Columns = Record<string, Column>;

const makeColumns = (def: ComponentDef<any>, capacity: number): Columns => {
  const cols: Columns = {};
  for (let f = 0; f < def.fields.length; f++) {
    cols[def.fields[f]!] = makeColumn(def.kinds[f]!, capacity);
  }
  return cols;
};

const growColumns = (
  def: ComponentDef<any>,
  cols: Columns,
  capacity: number
): void => {
  for (let f = 0; f < def.fields.length; f++) {
    const name = def.fields[f];
    cols[name!] = growColumn(def.kinds[f]!, cols[name!]!, capacity);
  }
};

const writeRow = (
  def: ComponentDef<any>,
  cols: Columns,
  row: number,
  value: any | undefined
): void => {
  for (let f = 0; f < def.fields.length; f++) {
    const name = def.fields[f];
    cols[name!]![row] =
      value === undefined
        ? def.kinds[f] === "ref"
          ? undefined
          : 0
        : value[name!];
  }
};

const readRow = (def: ComponentDef<any>, cols: Columns, row: number): any => {
  const out: any = {};
  for (let f = 0; f < def.fields.length; f++) {
    const name = def.fields[f];
    out[name!] = cols[name!]![row];
  }
  return out;
};

// ---------------------------------------------------------------------------
// Table (one archetype)
// ---------------------------------------------------------------------------

/** @internal */
export class Table {
  entities: Uint32Array;
  count = 0;
  capacity: number;
  /** Indexed by component id. The record identity is stable; its arrays are replaced on growth. */
  readonly columns: (Columns | undefined)[] = [];
  readonly ids: Set<number> = new Set();
  readonly addEdges: Map<number, Table> = new Map();
  readonly removeEdges: Map<number, Table> = new Map();

  constructor(
    readonly index: number,
    readonly defs: readonly ComponentDef<any>[],
    capacity = 16
  ) {
    this.capacity = capacity;
    this.entities = new Uint32Array(capacity);
    for (const def of defs) {
      this.ids.add(def.id);
      this.columns[def.id] = makeColumns(def, capacity);
    }
  }

  /** Appends a row. The caller must write every component of the new row. */
  push(entity: Entity): number {
    if (this.count === this.capacity) {
      const capacity = this.capacity * 2;
      const entities = new Uint32Array(capacity);
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
        if (def.kinds[f] === "ref") {
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
    readonly def: ComponentDef<any>,
    capacity = 16
  ) {
    this.dense = new Uint32Array(capacity);
    this.sparse = new Int32Array(64).fill(-1);
    this.columns = makeColumns(def, capacity);
  }

  has(index: number): boolean {
    return index < this.sparse.length && this.sparse[index] !== -1;
  }

  /** Row of an entity in `columns`. An arrow so it survives destructuring. */
  readonly indexOf = (entity: number): number =>
    this.sparse[entity & INDEX_MASK]!;

  add(index: number, value: any | undefined): void {
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
      if (def.kinds[f] === "ref") {
        col[last] = undefined;
      }
    }
    this.sparse[index] = -1;
    this.count = last;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type Terms = readonly ComponentDef<any>[];

/**
 * A world-independent description of a query. Any object with this shape
 * works; the Effect layer supplies a yieldable, pipeable implementation.
 */
export interface QuerySpec<D extends Terms = Terms> {
  /** Components whose data the query reads or writes (table or sparse). */
  readonly terms: D;
  /** Extra components an entity must have (table or sparse). */
  readonly withDefs: readonly ComponentDef<any>[];
  /** Components an entity must not have (table or sparse). */
  readonly withoutDefs: readonly ComponentDef<any>[];
}

export type AccessorsOf<D extends Terms> = {
  [K in keyof D]: D[K] extends ComponentDef<infer S extends Schema, any>
    ? ValueOf<S>
    : never;
};

/**
 * The columns of a sparse component. They are not aligned with table rows,
 * so look the row up per entity: `burning.columns.seconds[burning.indexOf(entity)]`.
 */
export interface SparseColumns<S extends Schema> {
  readonly columns: ColumnsOf<S>;
  /** Row of an entity in `columns`. Only meaningful for entities that have the component. */
  readonly indexOf: (entity: number) => number;
}

/** The entity ids of a table's rows. Reading an element gives an `Entity`. */
export type EntityColumn = Uint32Array & Readonly<Record<number, Entity>>;

export type ColumnSetsOf<D extends Terms> = {
  [K in keyof D]: D[K] extends ComponentDef<infer S extends Schema, infer St>
    ? St extends "sparse"
      ? SparseColumns<S>
      : ColumnsOf<S>
    : never;
};

/**
 * A query that requires a sparse component can find its matches two ways:
 * collect the component's members and sort them (cost grows with the number
 * of members), or mark them in a per-table mask and scan it (cost grows with
 * the number of rows). Measured with members in random order, sorting wins
 * once there are roughly 64 rows per member, so that is the switch-over.
 */
const SORT_ROWS_PER_MEMBER = 64;

/**
 * Scanning a mask with the native `indexOf` costs about 55 ns per call but
 * almost nothing per byte; a JS loop costs about 1 ns per byte. Native wins
 * when the stretches it skips average more than a few dozen rows.
 */
const NATIVE_SCAN_ROWS_PER_EXCEPTION = 64;

const ROW_RANGE = 4_294_967_296; // 2^32: keys are `slot * ROW_RANGE + row`

/** Scratch state for one level of nested iteration over the same view. */
interface Frame {
  readonly accessors: Accessor[];
  keys: Float64Array;
}

type Callback = (...args: any[]) => void;
type OnRun = (table: Table, start: number, end: number) => void;

export class QueryView<D extends Terms = Terms> {
  private readonly tables: Table[] = [];
  /** Indexed by table index: position in `tables`, or -1 when it does not match. */
  private readonly slotOf: number[] = [];
  private scanned = 0;

  private readonly n: number;
  /** Per term: its table component id, or -1 when the term is sparse. */
  private readonly termTableId: number[] = [];
  /** Per term: its sparse set, or undefined when the term is a table component. */
  private readonly termSet: (SparseSet | undefined)[] = [];
  private readonly hasSparseTerms: boolean;

  private readonly requiredIds: number[] = [];
  private readonly excludedIds: number[] = [];
  private readonly sparseWith: SparseSet[] = [];
  private readonly sparseWithout: SparseSet[] = [];
  /** True when some condition has to be checked per entity. */
  private readonly filtered: boolean;

  /**
   * One byte per row, per matching table: 1 means "skip this row". Between
   * iterations every byte holds `maskBase`; an iteration marks the exceptions,
   * walks the runs of 0s, and then puts the exceptions back.
   */
  private readonly masks: (Uint8Array | undefined)[] = [];
  /** 1 when a sparse component is required (rows are skipped unless marked), else 0. */
  private readonly maskBase: 0 | 1;

  /** How many mask bytes the current outermost iteration marked. */
  private exceptions = 0;

  private readonly frames: Frame[] = [];
  private depth = 0;

  /** @internal Test hook: force one strategy for queries that require a sparse component. */
  _path: "auto" | "sorted" | "mask" = "auto";
  /** @internal The strategy the last iteration used. */
  _lastPath: "dense" | "sorted" | "mask" = "dense";

  /** @internal */
  constructor(
    private readonly world: World,
    readonly spec: QuerySpec<D>
  ) {
    const requireSparse = (def: ComponentDef<any>): SparseSet => {
      const set = world._sparse(def);
      if (!this.sparseWith.includes(set)) {
        this.sparseWith.push(set);
      }
      return set;
    };
    for (const def of spec.terms) {
      if (def.storage === "table") {
        this.requiredIds.push(def.id);
        this.termTableId.push(def.id);
        this.termSet.push(undefined);
      } else {
        // Reading a sparse component's data implies requiring it.
        this.termTableId.push(-1);
        this.termSet.push(requireSparse(def));
      }
    }
    for (const def of spec.withDefs) {
      if (def.storage === "table") {
        this.requiredIds.push(def.id);
      } else {
        requireSparse(def);
      }
    }
    for (const def of spec.withoutDefs) {
      if (def.storage === "table") {
        this.excludedIds.push(def.id);
      } else {
        this.sparseWithout.push(world._sparse(def));
      }
    }
    this.n = spec.terms.length;
    this.hasSparseTerms = this.termSet.some((set) => set !== undefined);
    this.filtered = this.sparseWith.length + this.sparseWithout.length > 0;
    this.maskBase = this.sparseWith.length > 0 ? 1 : 0;
  }

  /** Picks up tables created since the last run. */
  private refresh(): void {
    const all = this.world.tables;
    for (; this.scanned < all.length; this.scanned++) {
      const table = all[this.scanned]!;
      let match = true;
      for (const id of this.requiredIds) {
        if (!table.ids.has(id)) {
          match = false;
          break;
        }
      }
      if (match) {
        for (const id of this.excludedIds) {
          if (table.ids.has(id)) {
            match = false;
            break;
          }
        }
      }
      this.slotOf[table.index] = match ? this.tables.length : -1;
      if (match) {
        this.tables.push(table);
      }
    }
  }

  /** The per-entity part of the filter: sparse `with` and `without`. */
  private pass(entity: number): boolean {
    const index = entity & INDEX_MASK;
    for (let s = 0; s < this.sparseWith.length; s++) {
      if (!this.sparseWith[s]!.has(index)) {
        return false;
      }
    }
    for (let s = 0; s < this.sparseWithout.length; s++) {
      if (this.sparseWithout[s]!.has(index)) {
        return false;
      }
    }
    return true;
  }

  // --- finding the matching rows ---------------------------------------------

  /**
   * Starts an iteration. Nested iteration over the same view (for example
   * comparing every pair of entities) gets its own accessors and scratch
   * space per level, so the inner loop cannot disturb the outer one.
   */
  private enter(): Frame {
    this.refresh();
    this.world._iterating++;
    const depth = this.depth++;
    return (this.frames[depth] ??= {
      accessors: this.spec.terms.map((def) => new def.Accessor()),
      keys: new Float64Array(64),
    });
  }

  private leave(): void {
    this.depth--;
    this.world._iterating--;
  }

  /**
   * Calls `onRun` for every run of consecutive matching rows, always in the
   * same order (tables in creation order, rows ascending), whichever strategy
   * finds them.
   */
  private runs(frame: Frame, onRun: OnRun): void {
    if (!this.filtered) {
      this._lastPath = "dense";
      for (let t = 0; t < this.tables.length; t++) {
        const table = this.tables[t]!;
        if (table.count > 0) {
          onRun(table, 0, table.count);
        }
      }
      return;
    }

    let smallest: SparseSet | undefined;
    for (let s = 0; s < this.sparseWith.length; s++) {
      const set = this.sparseWith[s]!;
      if (smallest === undefined || set.count < smallest.count) {
        smallest = set;
      }
    }
    if (smallest !== undefined && this.shouldSort(smallest)) {
      this._lastPath = "sorted";
      this.sortedRuns(frame, smallest, onRun);
      return;
    }

    this._lastPath = "mask";
    // Only the outermost iteration marks and restores. A nested one sees the
    // marks already in place, and nothing structural can change in between.
    const outermost = this.depth === 1;
    if (outermost) {
      this.exceptions = this.mark(smallest);
    }
    try {
      let rows = 0;
      for (let t = 0; t < this.tables.length; t++) {
        rows += this.tables[t]!.count;
      }
      // Long uniform stretches are skipped with a native scan (indexOf), which
      // is far faster per byte but costs more per call than a JS loop. Which
      // stretches are long depends on what the mask marks:
      //  - a required component (base 1): the skipped stretches, if it is rare
      //  - only exclusions (base 0): the matching runs, if exclusions are rare
      const rare = this.exceptions * NATIVE_SCAN_ROWS_PER_EXCEPTION < rows;
      const nativeSkip = rare && this.maskBase === 1;
      const nativeRun = rare && this.maskBase === 0;
      for (let t = 0; t < this.tables.length; t++) {
        const table = this.tables[t]!;
        const { count } = table;
        if (count === 0) {
          continue;
        }
        const mask = this.maskFor(t, table);
        let i = 0;
        while (i < count) {
          if (nativeSkip) {
            i = mask.indexOf(0, i);
            if (i === -1) {
              break;
            }
          } else {
            while (i < count && mask[i] === 1) {
              i++;
            }
          }
          if (i >= count) {
            break;
          }
          const start = i;
          if (nativeRun) {
            i = mask.indexOf(1, start + 1);
            if (i === -1 || i > count) {
              i = count;
            }
          } else {
            i++;
            while (i < count && mask[i] === 0) {
              i++;
            }
          }
          onRun(table, start, i);
        }
      }
    } finally {
      if (outermost) {
        this.unmark(smallest);
      }
    }
  }

  private shouldSort(smallest: SparseSet): boolean {
    if (this._path !== "auto") {
      return this._path === "sorted";
    }
    let rows = 0;
    for (let t = 0; t < this.tables.length; t++) {
      rows += this.tables[t]!.count;
    }
    return smallest.count * SORT_ROWS_PER_MEMBER <= rows;
  }

  private maskFor(slot: number, table: Table): Uint8Array {
    let mask = this.masks[slot];
    // A table only grows between iterations, when no marks are in place.
    if (mask === undefined || mask.length < table.capacity) {
      mask = new Uint8Array(table.capacity);
      if (this.maskBase === 1) {
        mask.fill(1);
      }
      this.masks[slot] = mask;
    }
    return mask;
  }

  /** Marks this iteration's exceptions to `maskBase` and returns how many there are. */
  private mark(smallest: SparseSet | undefined): number {
    let marked = 0;
    const { world } = this;
    // Safe to hold: these arrays are only replaced when an entity id is
    // reserved, and the entries for existing entities are copied unchanged.
    const recTable = world._recTable;
    const recRow = world._recRow;
    if (smallest === undefined) {
      // Only exclusions: nothing is skipped except members of an excluded set.
      for (let s = 0; s < this.sparseWithout.length; s++) {
        const set = this.sparseWithout[s]!;
        const dense = set.dense;
        for (let k = 0; k < set.count; k++) {
          const index = dense[k]!;
          const tableIndex = recTable[index]!;
          if (tableIndex < 0) continue;
          const slot = this.slotOf[tableIndex];
          if (slot === undefined || slot === -1) continue;
          this.maskFor(slot, this.tables[slot]!)[recRow[index]!] = 1;
          marked++;
        }
      }
    } else {
      // A sparse component is required: everything is skipped except the
      // members of the smallest required set that pass every other condition.
      const dense = smallest.dense;
      for (let k = 0; k < smallest.count; k++) {
        const index = dense[k]!;
        const tableIndex = recTable[index]!;
        if (tableIndex < 0) continue;
        const slot = this.slotOf[tableIndex];
        if (slot === undefined || slot === -1) continue;
        const table = this.tables[slot]!;
        const row = recRow[index];
        if (this.pass(table.entities[row!]!)) {
          this.maskFor(slot, table)[row!] = 0;
          marked++;
        }
      }
    }
    return marked;
  }

  /** Puts every byte `mark` could have touched back to `maskBase`. */
  private unmark(smallest: SparseSet | undefined): void {
    const recTable = this.world._recTable;
    const recRow = this.world._recRow;
    const sets = smallest === undefined ? this.sparseWithout : [smallest];
    for (let s = 0; s < sets.length; s++) {
      const set = sets[s]!;
      const { dense } = set;
      for (let k = 0; k < set.count; k++) {
        const index = dense[k]!;
        const tableIndex = recTable[index]!;
        if (tableIndex < 0) {
          continue;
        }
        const slot = this.slotOf[tableIndex];
        if (slot === undefined || slot === -1) {
          continue;
        }
        const mask = this.masks[slot];
        if (mask !== undefined) {
          mask[recRow[index]!] = this.maskBase;
        }
      }
    }
  }

  /** For very rare required components: collect the matches, sort, merge into runs. */
  private sortedRuns(frame: Frame, smallest: SparseSet, onRun: OnRun): void {
    const recTable = this.world._recTable;
    const recRow = this.world._recRow;
    if (frame.keys.length < smallest.count) {
      frame.keys = new Float64Array(
        Math.max(smallest.count, frame.keys.length * 2)
      );
    }
    const { keys } = frame;
    const { dense } = smallest;
    let m = 0;
    for (let k = 0; k < smallest.count; k++) {
      const index = dense[k]!;
      const tableIndex = recTable[index]!;
      if (tableIndex < 0) {
        continue;
      }
      const slot = this.slotOf[tableIndex];
      if (slot === undefined || slot === -1) {
        continue;
      }
      const row = recRow[index]!;
      if (this.pass(this.tables[slot]!.entities[row]!)) {
        keys[m++] = slot * ROW_RANGE + row;
      }
    }
    keys.subarray(0, m).sort();
    let k = 0;
    while (k < m) {
      const slot = Math.floor(keys[k]! / ROW_RANGE);
      const start = keys[k]! - slot * ROW_RANGE;
      let end = start + 1;
      k++;
      while (k < m && keys[k] === slot * ROW_RANGE + end) {
        end++;
        k++;
      }
      onRun(this.tables[slot]!, start, end);
    }
  }

  // --- each: one callback per entity, through accessors -----------------------

  /**
   * Calls `fn` once per matching entity with one accessor per term.
   *
   * The accessors are reused between calls: read and write through them
   * inside the callback, but do not keep them.
   */
  each(fn: (...args: [...AccessorsOf<D>, entity: Entity]) => void): void {
    const frame = this.enter();
    try {
      const f = fn as Callback;
      const acc = frame.accessors;
      // Sparse columns can be replaced when a set grows, so bind them per call.
      for (let k = 0; k < this.n; k++) {
        const set = this.termSet[k];
        if (set !== undefined) {
          acc[k]!._bind(set.columns);
        }
      }
      let bound: Table | undefined;
      this.runs(frame, (table, start, end) => {
        if (table !== bound) {
          for (let k = 0; k < this.n; k++) {
            const id = this.termTableId[k];
            if (id !== -1) {
              acc[k]!._bind(table.columns[id!]!);
            }
          }
          bound = table;
        }
        if (this.hasSparseTerms) {
          this.visitSparse(f, acc, table.entities, start, end);
        } else {
          this.visit(f, acc, table.entities, start, end);
        }
      });
    } finally {
      this.leave();
    }
  }

  /** The hot loop: rows `[start, end)` of one table, all terms row-aligned. */
  private visit(
    f: Callback,
    acc: Accessor[],
    ents: Uint32Array,
    start: number,
    end: number
  ): void {
    const { n } = this;
    // Specialised by arity so the callback is called with a fixed number
    // of arguments (a spread call here costs roughly 3x).
    if (n === 1) {
      const a = acc[0]!;
      for (let i = start; i < end; i++) {
        a._i = i;
        f(a, ents[i]);
      }
    } else if (n === 2) {
      const a = acc[0]!;
      const b = acc[1]!;
      for (let i = start; i < end; i++) {
        a._i = i;
        b._i = i;
        f(a, b, ents[i]);
      }
    } else if (n === 3) {
      const a = acc[0]!;
      const b = acc[1]!;
      const c = acc[2]!;
      for (let i = start; i < end; i++) {
        a._i = i;
        b._i = i;
        c._i = i;
        f(a, b, c, ents[i]);
      }
    } else {
      const args: any[] = Array.from({ length: n + 1 });
      for (let k = 0; k < n; k++) {
        args[k] = acc[k];
      }
      for (let i = start; i < end; i++) {
        for (let k = 0; k < n; k++) {
          acc[k]!._i = i;
        }
        args[n] = ents[i];
        f.apply(undefined, args);
      }
    }
  }

  /** As `visit`, but sparse terms need their own row looked up per entity. */
  private visitSparse(
    f: Callback,
    acc: Accessor[],
    ents: Uint32Array,
    start: number,
    end: number
  ): void {
    const { n } = this;
    for (let i = start; i < end; i++) {
      const entity = ents[i]!;
      for (let k = 0; k < n; k++) {
        const set = this.termSet[k];
        acc[k]!._i = set === undefined ? i : set.sparse[entity & INDEX_MASK]!;
      }
      if (n === 1) {
        f(acc[0], entity);
      } else if (n === 2) {
        f(acc[0], acc[1], entity);
      } else if (n === 3) {
        f(acc[0], acc[1], acc[2], entity);
      } else {
        f(...acc, entity);
      }
    }
  }

  // --- eachChunk: raw columns, the caller writes the loop ---------------------

  /**
   * The fast path. Calls `fn` with raw columns and a range of rows
   * `[start, end)` that all match; write your own loop over it:
   *
   *   view.eachChunk((start, end, pos, vel) => {
   *     for (let i = start; i < end; i++) pos.x[i] += vel.x[i] * dt
   *   })
   *
   * A query with no sparse conditions gets one chunk per table. With sparse
   * conditions, each table is split into runs of consecutive matching rows.
   *
   * Sparse data terms arrive as `{ columns, indexOf }` because their rows do
   * not line up with the table's.
   */
  eachChunk(
    fn: (
      start: number,
      end: number,
      ...args: [...ColumnSetsOf<D>, entities: EntityColumn]
    ) => void
  ): void {
    const frame = this.enter();
    try {
      const f = fn as Callback;
      const { n } = this;
      const cols: any[] = Array.from({ length: n });
      for (let k = 0; k < n; k++) {
        cols[k] = this.termSet[k];
      }
      let bound: Table | undefined;
      this.runs(frame, (table, start, end) => {
        if (table !== bound) {
          for (let k = 0; k < n; k++) {
            const id = this.termTableId[k];
            if (id !== -1) {
              cols[k] = table.columns[id!];
            }
          }
          bound = table;
        }
        const ents = table.entities;
        if (n === 1) {
          f(start, end, cols[0], ents);
        } else if (n === 2) {
          f(start, end, cols[0], cols[1], ents);
        } else if (n === 3) {
          f(start, end, cols[0], cols[1], cols[2], ents);
        } else {
          f(start, end, ...cols, ents);
        }
      });
    } finally {
      this.leave();
    }
  }

  // --- conveniences -----------------------------------------------------------

  /** Number of matching entities. */
  count(): number {
    this.refresh();
    let total = 0;
    for (const table of this.tables) {
      if (this.filtered) {
        for (let i = 0; i < table.count; i++) {
          if (this.pass(table.entities[i]!)) total++;
        }
      } else {
        total += table.count;
      }
    }
    return total;
  }

  /** The matching entities in iteration order, copied into a new array. */
  entities(): Entity[] {
    this.refresh();
    const out: Entity[] = [];
    for (const table of this.tables) {
      for (let i = 0; i < table.count; i++) {
        if (!this.filtered || this.pass(table.entities[i]!)) {
          out.push(table.entities[i] as Entity);
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export class World {
  private recTable = new Int32Array(1024).fill(FREE);
  private recRow = new Int32Array(1024);
  /** @internal Table index per entity index (negative when not in a table). */
  get _recTable(): Int32Array {
    return this.recTable;
  }
  /** @internal Row per entity index. */
  get _recRow(): Int32Array {
    return this.recRow;
  }
  private gens = new Uint16Array(1024);
  private readonly freeList: number[] = [];
  private nextIndex = 0;
  private alive = 0;

  /** @internal */
  readonly tables: Table[] = [];
  private readonly tableByKey = new Map<string, Table>();
  private readonly sparseById = new Map<number, SparseSet>();
  private readonly sparseList: SparseSet[] = [];
  private readonly views = new Map<QuerySpec<any>, QueryView<any>>();
  private readonly componentsByName = new Map<string, ComponentDef<any>>();
  /** Indexed by component id: true once registered, so the usual check is one read. */
  private readonly registered: (true | undefined)[] = [];

  /** @internal Depth of query iteration in progress. */
  _iterating = 0;

  /**
   * The world's random number generator. Its state is part of the world, so
   * everything random in a simulation comes from here.
   */
  readonly random: Rng;

  /** @param options.seed where the random sequence starts; 0 when left out. */
  constructor(options?: { readonly seed?: number }) {
    this.random = new Rng(options?.seed ?? 0);
  }

  /** Number of live entities. */
  get entityCount(): number {
    return this.alive;
  }

  // --- entities ------------------------------------------------------------

  isAlive(entity: Entity): boolean {
    const index = entityIndex(entity);
    return (
      index < this.nextIndex &&
      this.recTable[index] !== FREE &&
      this.gens[index] === entityGeneration(entity)
    );
  }

  /**
   * Allocates an entity id without placing it in a table. Used by
   * CommandBuffer so `spawn` can return an id before the spawn is applied.
   * @internal
   */
  _reserve(): Entity {
    let index: number;
    if (this.freeList.length > 0) {
      index = this.freeList.pop()!;
    } else {
      index = this.nextIndex++;
      if (index > INDEX_MASK) {
        throw new Error("Entity limit reached");
      }
      if (index >= this.recTable.length) {
        this.growRecords();
      }
    }
    this.recTable[index] = NOT_PLACED;
    this.alive++;
    return makeEntity(index, this.gens[index]!);
  }

  private growRecords(): void {
    const size = this.recTable.length * 2;
    const recTable = new Int32Array(size).fill(FREE);
    recTable.set(this.recTable);
    this.recTable = recTable;
    const recRow = new Int32Array(size);
    recRow.set(this.recRow);
    this.recRow = recRow;
    const gens = new Uint16Array(size);
    gens.set(this.gens);
    this.gens = gens;
  }

  /** @internal */
  _place(entity: Entity, inputs: readonly ComponentInput[]): void {
    const index = entityIndex(entity);
    // Later inputs win when the same component is given twice.
    const byId = new Map<number, ComponentInput>();
    for (const input of inputs) {
      byId.set((isComponentDef(input) ? input : input.def).id, input);
    }
    const tableDefs: ComponentDef<any>[] = [];
    for (const input of byId.values()) {
      const def = isComponentDef(input) ? input : input.def;
      if (def.storage === "table") {
        tableDefs.push(def);
      }
    }
    tableDefs.sort((a, b) => a.id - b.id);
    const table = this.tableFor(tableDefs);
    const row = table.push(entity);
    for (const input of byId.values()) {
      const def = isComponentDef(input) ? input : input.def;
      const value = isComponentDef(input) ? undefined : input.value;
      if (def.storage === "table") {
        writeRow(def, table.columns[def.id]!, row, value);
      } else {
        this._sparse(def).add(index, value);
      }
    }
    this.recTable[index] = table.index;
    this.recRow[index] = row;
  }

  spawn(...inputs: readonly ComponentInput[]): Entity {
    this.assertNotIterating("spawn");
    // Before an id is reserved, so a refused component leaves nothing behind.
    this._registerAll(inputs);
    const entity = this._reserve();
    this._place(entity, inputs);
    return entity;
  }

  despawn(entity: Entity): boolean {
    this.assertNotIterating("despawn");
    if (!this.isAlive(entity)) {
      return false;
    }
    const index = entityIndex(entity);
    const tableIndex = this.recTable[index];
    if (tableIndex !== NOT_PLACED) {
      const row = this.recRow[index]!;
      const moved = this.tables[tableIndex!]!.swapRemove(row);
      if (moved !== undefined) {
        this.recRow[entityIndex(moved)] = row;
      }
    }
    for (const set of this.sparseList) {
      set.remove(index);
    }
    this.recTable[index] = FREE;
    // Generations wrap after 1024 reuses of a slot; a handle held that long
    // could alias a newer entity.
    this.gens[index] = (this.gens[index]! + 1) & GENERATION_MASK;
    this.freeList.push(index);
    this.alive--;
    return true;
  }

  // --- components ----------------------------------------------------------

  add(entity: Entity, input: ComponentInput): boolean {
    this.assertNotIterating("add");
    if (!this.isAlive(entity)) {
      return false;
    }
    const index = entityIndex(entity);
    const def = isComponentDef(input) ? input : input.def;
    const value = isComponentDef(input) ? undefined : input.value;
    if (def.storage === "sparse") {
      this._sparse(def).add(index, value);
      return true;
    }
    const from = this.placedTable(index);
    if (from.ids.has(def.id)) {
      if (value !== undefined) {
        writeRow(def, from.columns[def.id]!, this.recRow[index]!, value);
      }
      return true;
    }
    let to = from.addEdges.get(def.id);
    if (to === undefined) {
      to = this.tableFor([...from.defs, def].sort((a, b) => a.id - b.id));
      from.addEdges.set(def.id, to);
    }
    const row = this.move(entity, from, to);
    writeRow(def, to.columns[def.id]!, row, value);
    return true;
  }

  remove(entity: Entity, def: ComponentDef<any>): boolean {
    this.assertNotIterating("remove");
    if (!this.isAlive(entity)) {
      return false;
    }
    const index = entityIndex(entity);
    if (def.storage === "sparse") {
      return this._sparse(def).remove(index);
    }
    const from = this.placedTable(index);
    if (!from.ids.has(def.id)) {
      return false;
    }
    let to = from.removeEdges.get(def.id);
    if (to === undefined) {
      to = this.tableFor(from.defs.filter((d) => d.id !== def.id));
      from.removeEdges.set(def.id, to);
    }
    this.move(entity, from, to);
    return true;
  }

  has(entity: Entity, def: ComponentDef<any>): boolean {
    if (!this.isAlive(entity)) {
      return false;
    }
    const index = entityIndex(entity);
    if (def.storage === "sparse") {
      return this._sparse(def).has(index);
    }
    const tableIndex = this.recTable[index];
    return (
      tableIndex !== NOT_PLACED && this.tables[tableIndex!]!.ids.has(def.id)
    );
  }

  /** Reads a component as a new plain object. Convenient, not for hot loops. */
  get<S extends Schema>(
    entity: Entity,
    def: ComponentDef<S>
  ): ValueOf<S> | undefined {
    if (!this.has(entity, def)) {
      return undefined;
    }
    const index = entityIndex(entity);
    if (def.storage === "sparse") {
      const set = this._sparse(def);
      return readRow(def, set.columns, set.sparse[index]!);
    }
    return readRow(
      def,
      this.tables[this.recTable[index]!]!.columns[def.id]!,
      this.recRow[index]!
    );
  }

  /** Writes some or all fields of a component the entity already has. */
  set<S extends Schema>(
    entity: Entity,
    def: ComponentDef<S>,
    value: Partial<ValueOf<S>>
  ): boolean {
    if (!this.has(entity, def)) {
      return false;
    }
    const index = entityIndex(entity);
    let cols: Columns;
    let row: number;
    if (def.storage === "sparse") {
      const set = this._sparse(def);
      cols = set.columns;
      row = set.sparse[index]!;
    } else {
      cols = this.tables[this.recTable[index]!]!.columns[def.id]!;
      row = this.recRow[index]!;
    }
    for (const key in value) {
      cols[key]![row] = value[key] as any;
    }
    return true;
  }

  /**
   * Tells the world about a component. A component is registered the first
   * time the world stores or queries it, so this is only needed to look one
   * up by name before then. Its name is its identity in this world: a second
   * component with the same name is refused.
   */
  register(def: ComponentDef<any>): void {
    if (this.registered[def.id] === true) {
      return;
    }
    const known = this.componentsByName.get(def.name);
    if (known !== undefined) {
      throw new Error(
        `Two different components are both named "${def.name}". A component's name identifies it in a world, so give each its own, prefixed with the feature it belongs to.`
      );
    }
    this.componentsByName.set(def.name, def);
    this.registered[def.id] = true;
  }

  /** @internal Registers the component of every input. */
  _registerAll(inputs: readonly ComponentInput[]): void {
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!;
      this.register(isComponentDef(input) ? input : input.def);
    }
  }

  /** The registered component with this name, for saves, the network and tools. */
  component(name: string): ComponentDef<any> | undefined {
    return this.componentsByName.get(name);
  }

  // --- queries -------------------------------------------------------------

  /** Resolves a query description against this world. Cached per description. */
  view<D extends Terms>(spec: QuerySpec<D>): QueryView<D> {
    let view = this.views.get(spec);
    if (view === undefined) {
      for (const def of spec.terms) {
        this.register(def);
      }
      for (const def of spec.withDefs) {
        this.register(def);
      }
      for (const def of spec.withoutDefs) {
        this.register(def);
      }
      view = new QueryView(this, spec);
      this.views.set(spec, view);
    }
    return view;
  }

  // --- internals -----------------------------------------------------------

  /** @internal */
  _sparse(def: ComponentDef<any>): SparseSet {
    let set = this.sparseById.get(def.id);
    if (set === undefined) {
      this.register(def);
      set = new SparseSet(def);
      this.sparseById.set(def.id, set);
      this.sparseList.push(set);
    }
    return set;
  }

  private tableFor(sortedDefs: readonly ComponentDef<any>[]): Table {
    const key = sortedDefs.map((d) => d.id).join(",");
    let table = this.tableByKey.get(key);
    if (table === undefined) {
      for (const def of sortedDefs) {
        this.register(def);
      }
      table = new Table(this.tables.length, sortedDefs);
      this.tables.push(table);
      this.tableByKey.set(key, table);
    }
    return table;
  }

  private placedTable(index: number): Table {
    const tableIndex = this.recTable[index];
    if (tableIndex === NOT_PLACED) {
      throw new Error(
        "Entity was spawned through a CommandBuffer that has not been applied yet"
      );
    }
    return this.tables[tableIndex!]!;
  }

  /** Moves an entity between tables, copying the components both have. Returns the new row. */
  private move(entity: Entity, from: Table, to: Table): number {
    const index = entityIndex(entity);
    const oldRow = this.recRow[index]!;
    const newRow = to.push(entity);
    for (const def of to.defs) {
      const src = from.columns[def.id];
      if (src === undefined) {
        continue;
      }
      const dst = to.columns[def.id]!;
      for (let f = 0; f < def.fields.length; f++) {
        const name = def.fields[f];
        dst[name!]![newRow] = src[name!]![oldRow];
      }
    }
    const moved = from.swapRemove(oldRow);
    if (moved !== undefined) {
      this.recRow[entityIndex(moved)] = oldRow;
    }
    this.recTable[index] = to.index;
    this.recRow[index] = newRow;
    return newRow;
  }

  private assertNotIterating(op: string): void {
    if (this._iterating > 0) {
      throw new Error(
        `World.${op}() called while a query is iterating. Queue it on a CommandBuffer and apply it after the loop.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Command buffer
// ---------------------------------------------------------------------------

type Command =
  | {
      readonly op: "spawn";
      readonly entity: Entity;
      readonly inputs: readonly ComponentInput[];
    }
  | { readonly op: "despawn"; readonly entity: Entity }
  | {
      readonly op: "add";
      readonly entity: Entity;
      readonly input: ComponentInput;
    }
  | {
      readonly op: "remove";
      readonly entity: Entity;
      readonly def: ComponentDef<any>;
    };

/**
 * Queues structural changes so they can be made from inside query loops and
 * applied in one pass at a known point in the tick.
 */
export class CommandBuffer {
  private ops: Command[] = [];

  constructor(readonly world: World) {}

  get size(): number {
    return this.ops.length;
  }

  /** Returns the new entity's id immediately; it gets its components on apply. */
  spawn(...inputs: readonly ComponentInput[]): Entity {
    // Checked here, where the mistake is, and not when the queue is applied.
    this.world._registerAll(inputs);
    const entity = this.world._reserve();
    this.ops.push({ op: "spawn", entity, inputs });
    return entity;
  }

  despawn(entity: Entity): void {
    this.ops.push({ op: "despawn", entity });
  }

  add(entity: Entity, input: ComponentInput): void {
    this.world.register(isComponentDef(input) ? input : input.def);
    this.ops.push({ op: "add", entity, input });
  }

  remove(entity: Entity, def: ComponentDef<any>): void {
    this.ops.push({ op: "remove", entity, def });
  }

  /** A position in the queue, for `rollback`. */
  mark(): number {
    return this.ops.length;
  }

  /**
   * Discards every command queued since `mark`, releasing the ids of
   * entities whose spawn is being discarded.
   */
  rollback(mark: number): void {
    for (let i = mark; i < this.ops.length; i++) {
      const cmd = this.ops[i]!;
      if (cmd.op === "spawn") {
        this.world.despawn(cmd.entity);
      }
    }
    this.ops.length = Math.min(this.ops.length, mark);
  }

  /** Applies queued commands in order. Returns how many were applied. */
  apply(): number {
    if (this.ops.length === 0) {
      return 0;
    }
    const { ops } = this;
    this.ops = [];
    const { world } = this;
    for (let i = 0; i < ops.length; i++) {
      const cmd = ops[i]!;
      switch (cmd.op) {
        case "spawn": {
          if (world.isAlive(cmd.entity)) world._place(cmd.entity, cmd.inputs);
          break;
        }
        case "despawn": {
          world.despawn(cmd.entity);
          break;
        }
        case "add": {
          world.add(cmd.entity, cmd.input);
          break;
        }
        case "remove": {
          world.remove(cmd.entity, cmd.def);
          break;
        }
      }
    }
    return ops.length;
  }
}
