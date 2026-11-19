/**
 * The archetype storage core.
 *
 * - Entities with the same set of table components live together in a table,
 *   with one column per field (typed arrays for numeric fields).
 * - Components declared with `storage: "sparse"` live in their own sparse set,
 *   so adding or removing them never moves an entity between tables. Queries
 *   can require them, exclude them, and read their data.
 * - Iteration order is always the same: tables in creation order, rows
 *   ascending. It doesn't depend on how the matching rows were found.
 * - Queries cache the tables they match, and only examine tables created since
 *   they last ran.
 * - Structural changes (spawn, despawn, add, remove) aren't allowed while a
 *   query is iterating. Queue them on a `CommandBuffer` instead.
 * - A world owns a seeded random number generator, so its state is part of the
 *   world.
 * - A snapshot is the whole world as bytes. It loads into an empty world, which
 *   then hashes the same and continues the same way.
 * - A transaction (`begin`, then `commit` or `rollback`) can roll back every
 *   write to component data made since it began. Whatever is about to be
 *   written is saved first: one row for `set`, and the visited columns for a
 *   query's loop.
 * - A query can ask for changes only: the entities that gained a component or
 *   had one written since the query last visited them. Writes are recorded per
 *   row, and only for components some query watches.
 * - A world can be given a guard: what the running code declared it would read
 *   and write. The world then refuses everything else, at the point it is
 *   attempted.
 *
 * No Effect dependency.
 */
import {
  GENERATIONS,
  INDEX_MASK,
  entityIndex,
  frozenWrite,
  growColumn,
  isBoxed,
  isComponentDef,
  makeAccessor,
  makeColumn,
  makeEntity,
  retarget,
} from "./component";
import type {
  Accessor,
  Column,
  ColumnsOf,
  ComponentDef,
  ComponentInput,
  ComponentValue,
  Entity,
  ReadOnlyTerm,
  ReadonlyColumnsOf,
  Row,
  Schema,
  SingletonSpec,
  Storage,
  ValueOf,
} from "./component";
import { add, addColumn, addColumnPerRow, finish, shapeOf } from "./hash";
import { Rng } from "./random";
import {
  END,
  FORMAT,
  KIND_CODES,
  MAGIC,
  Reader,
  STORAGES,
  SnapshotError,
  WIDTH,
  Writer,
  readColumn,
  writeColumn,
} from "./snapshot";

const NOT_PLACED = -1;
const FREE = -2;
/** The number of slots: what an id's generation is multiplied by. */
const SLOTS = INDEX_MASK + 1;
/** In a `Saved`, the row value that means "every row". */
const WHOLE = -1;
/** What `hash` folds in before each singleton, to distinguish it from a sparse set. */
const SINGLETON = 0x53_49_4e_47;
const storageOf = (def: ComponentDef): 0 | 1 | 2 =>
  def.single ? 2 : def.storage === "sparse" ? 1 : 0;

/** The single instance of a singleton that a world holds. */
interface Single {
  readonly def: ComponentDef;
  /** One row. */
  readonly columns: Columns;
  /**
   * Its value in a world that hasn't written it, once the world has been given
   * it: what `restore` puts back when the snapshot doesn't hold it.
   */
  initial: Readonly<Record<string, unknown>> | undefined;
  /**
   * False until it is first written. Until then it holds its initial value and
   * behaves as if absent: it isn't saved, and isn't in the hash.
   */
  written: boolean;
  /** What `World.singleton` returns: reads and writes go to `columns`. */
  readonly value: object;
}

type Columns = Record<string, Column>;

/** What a transaction saved before a write: one row, or whole columns. */
interface Saved {
  readonly cols: Columns;
  readonly def: ComponentDef;
  /** `WHOLE`, or the one row that was saved. */
  readonly row: number;
  /** How many rows `copies` holds when it holds whole columns. */
  readonly count: number;
  /**
   * For each field, a copy of the column's first `count` rows (the array may be
   * longer, since it is reused), or the single row's value.
   */
  readonly copies: unknown[];
}

const makeColumns = (def: ComponentDef, capacity: number): Columns => {
  const cols: Columns = {};
  for (let f = 0; f < def.fields.length; f++) {
    cols[def.fields[f]!] = makeColumn(def.kinds[f]!, capacity);
  }
  return cols;
};

const growColumns = (
  def: ComponentDef,
  cols: Columns,
  capacity: number
): void => {
  for (let f = 0; f < def.fields.length; f++) {
    const name = def.fields[f];
    cols[name!] = growColumn(def.kinds[f]!, cols[name!]!, capacity);
  }
};

const writeRow = (
  def: ComponentDef,
  cols: Columns,
  row: number,
  value: Readonly<Record<string, unknown>> | undefined
): void => {
  for (let f = 0; f < def.fields.length; f++) {
    const name = def.fields[f];
    // A number that is not given is 0, whether the whole value was left
    // out or the one field, which JavaScript and a cast allow: written as
    // it came, an undefined would be NaN in a column of floats.
    const given = value === undefined ? undefined : value[name!];
    cols[name!]![row] =
      given === undefined && !isBoxed(def.kinds[f]!) ? 0 : given;
  }
};

const readRow = (
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

const corrupt = (how: string): SnapshotError =>
  new SnapshotError("corrupt", `The snapshot is damaged: ${how}.`);

/** Explains that a relation was given without a value, and so has no target. */
const targetless = (def: ComponentDef): Error =>
  new Error(
    `"${def.name}" is a relation, and a relation needs a target: give it as ${def.name.split("/").pop()}.of({ target }).`
  );

/** Summarizes a value in a few words, for a message. */
const describeValue = (value: unknown): string =>
  typeof value === "function"
    ? "a function"
    : typeof value === "symbol"
      ? "a symbol"
      : Array.isArray(value)
        ? "an array"
        : "an object";

/** Orders by name, by UTF-16 code unit: the same in every engine and locale. */
const byName = (a: { readonly name: string }, b: { readonly name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

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

// ---------------------------------------------------------------------------
// Change logs (one per watched component and kind of change)
// ---------------------------------------------------------------------------

/**
 * What a change query visits: entities whose component was written, added or
 * removed.
 *
 * @category Models
 */
export type ChangeKind = "changed" | "added" | "removed";

/** A reader's place in a change log. @internal */
export interface ChangeCursor {
  /** Sequence number of the first entry the reader has yet to visit. */
  at: number;
  /** The reader's identity, as a save records it. */
  readonly key: string;
  /**
   * True until the reader's first visit, which covers everything that has the
   * component, since the log only knows what happened after it started.
   */
  fresh: boolean;
  /** False for a reader loaded from a save that no one has requested yet. */
  claimed: boolean;
}

/**
 * One component's changes of one kind, as a save holds them.
 *
 * @category Models
 */
export interface SavedChanges {
  readonly component: string;
  readonly kind: ChangeKind;
  /**
   * What some reader has yet to visit, oldest first: entity indexes for
   * `changed` and `added`, entity ids for `removed`.
   */
  readonly entries: readonly number[];
  /** For each reader, how many of the entries it has visited. */
  readonly readers: Readonly<Record<string, number>>;
}

/**
 * What happened to one component, in the order it happened, for the queries
 * that watch it: which entities had it written, or gained it, or lost it.
 *
 * Every reader has a place in the log and visits what was logged since its
 * last visit, so each reader sees each change once however often it runs.
 * Entries every reader has visited are forgotten.
 *
 * A `changed` or `added` log holds entity indexes, at most one for each
 * entity that no reader has visited yet: `noted` says, per entity, whether
 * it has one. A `removed` log holds entity ids, one per removal.
 * @internal
 */
export class ChangeLog {
  /** Entity indexes, or entity ids for a `removed` log, which are wider. */
  private entries: Uint32Array | Float64Array;
  /** The position in `entries` of the entry numbered `base`. */
  private first = 0;
  /** Sequence number of the oldest entry kept. */
  base = 0;
  /** One past the sequence number of the newest entry. */
  end = 0;
  /**
   * For each entity index, 1 when the entity has an entry no reader has
   * visited, so it doesn't need logging again. Those are the entries from
   * `floor` on.
   */
  noted: Uint8Array;
  /**
   * Where the log ended the last time a reader visited. A reader visits up to
   * the end, so entries before this have been visited by someone.
   */
  private floor = 0;
  readonly cursors: ChangeCursor[] = [];
  /** Where the log ended when the current transaction began. */
  txEnd = 0;

  constructor(
    readonly def: ComponentDef,
    readonly kind: ChangeKind,
    private readonly world: World
  ) {
    // As long as the world's own records, and grown with them, so that a
    // read is never past its end: a read past the end of a typed array
    // makes every later read at that place in the code slower.
    this.noted = new Uint8Array(
      kind === "removed" ? 0 : world._recTable.length
    );
    this.entries = this.room(64);
  }

  /** Allocates an array for this many entries, of the type this log holds. */
  private room(size: number): Uint32Array | Float64Array {
    return this.kind === "removed"
      ? new Float64Array(size)
      : new Uint32Array(size);
  }

  /** Records that the entity at `index` changed, unless a pending entry already says so. */
  note(index: number): void {
    if (this.noted[index] === 1) {
      return;
    }
    this.push(index);
    this.noted[index] = 1;
  }

  /** Makes room for the flags of `size` entities. */
  grow(size: number): void {
    if (this.kind !== "removed" && size > this.noted.length) {
      const noted = new Uint8Array(size);
      noted.set(this.noted);
      this.noted = noted;
    }
  }

  /** Records rows `[start, end)` of a table's entities, or of a sparse set's members. */
  noteRows(
    entities: Uint32Array | Float64Array,
    start: number,
    end: number
  ): void {
    // Room for all of them first, so that the loop is two reads, a
    // comparison and, for a row not noted yet, two writes.
    while (
      this.first + (this.end - this.base) + (end - start) >
      this.entries.length
    ) {
      this.makeRoom();
    }
    const { entries, noted } = this;
    let tail = this.first + (this.end - this.base);
    const before = tail;
    for (let row = start; row < end; row++) {
      const index = entities[row]! & INDEX_MASK;
      if (noted[index] === 1) {
        continue;
      }
      entries[tail++] = index;
      noted[index] = 1;
    }
    this.end += tail - before;
  }

  /** Appends an entry regardless of what the log holds: an entity id, for a removal. */
  push(value: number): void {
    let tail = this.first + (this.end - this.base);
    if (tail === this.entries.length) {
      tail = this.makeRoom();
    }
    this.entries[tail] = value;
    this.end++;
  }

  /** Makes room for one more entry and returns its position. */
  private makeRoom(): number {
    // A reader that has not run for a long time keeps everything logged
    // since. Before the log outgrows the world, entities logged more than
    // once are brought down to once. Not in a transaction, whose rollback
    // counts on the entries staying where they are.
    if (
      this.kind !== "removed" &&
      !this.world._recording &&
      this.end - this.base > 2 * this.world._slots + 1024
    ) {
      this.compact();
    }
    const size = this.end - this.base;
    if (size > this.entries.length >> 1 || this.first === 0) {
      const entries = this.room(this.entries.length * 2);
      entries.set(this.entries.subarray(this.first, this.first + size));
      this.entries = entries;
    } else {
      this.entries.copyWithin(0, this.first, this.first + size);
    }
    this.first = 0;
    return size;
  }

  /**
   * Keeps the newest entry of every entity and drops the rest. Each reader
   * still visits exactly the entities it had yet to visit: an entity with an
   * entry at or after a reader's position has its newest one there.
   */
  private compact(): void {
    const { cursors, entries, first } = this;
    const size = this.end - this.base;
    const seen = new Uint8Array(this.world._slots);
    // Readers from the one furthest on: each new place is the end less the
    // entries kept at or past the old one. The floor moves as a reader's
    // place does.
    const floor = { at: this.floor };
    const byPlace = [...cursors, floor].toSorted((a, b) => b.at - a.at);
    const places: number[] = [];
    let next = 0;
    let kept = 0;
    let write = first + size;
    for (let read = first + size - 1; read >= first; read--) {
      const sequence = this.base + (read - first);
      while (next < byPlace.length && byPlace[next]!.at > sequence) {
        places[next++] = this.end - kept;
      }
      const index = entries[read]!;
      if (seen[index] === 1) {
        continue;
      }
      seen[index] = 1;
      entries[--write] = index;
      kept++;
    }
    while (next < byPlace.length) {
      places[next++] = this.end - kept;
    }
    for (let i = 0; i < byPlace.length; i++) {
      byPlace[i]!.at = places[i]!;
    }
    this.first = write;
    this.base = this.end - kept;
    // An entity that is noted has one entry past the floor, its newest,
    // which was kept: `noted` stands as it is.
    this.floor = floor.at;
    this.moved();
  }

  /**
   * Returns the reader identified by `key`: the one a save restored, at its
   * position, or a new one that starts by visiting everything.
   */
  cursor(key: string, fresh = true): ChangeCursor {
    for (const cursor of this.cursors) {
      if (cursor.key === key) {
        if (cursor.claimed) {
          throw new Error(
            `Two readers of what ${this.kind === "removed" ? "lost" : this.kind} "${this.def.name}" are both known as ${JSON.stringify(key)}.`
          );
        }
        cursor.claimed = true;
        return cursor;
      }
    }
    const cursor = { at: this.end, key, fresh, claimed: true };
    this.cursors.push(cursor);
    return cursor;
  }

  /** Copies the entries from sequence number `from` on into `into` at `offset`. */
  copy(from: number, into: Uint32Array | Float64Array, offset: number): void {
    const start = this.first + (Math.max(from, this.base) - this.base);
    into.set(
      this.entries.subarray(start, this.first + (this.end - this.base)),
      offset
    );
  }

  /** Returns how many entries a reader at `from` has yet to visit. */
  waiting(from: number): number {
    return this.end - Math.max(from, this.base);
  }

  /**
   * Call when a reader has visited up to the end. The entities logged since the
   * last visit have now been visited by someone, so the next write of each is
   * logged again.
   */
  visited(): void {
    if (this.kind !== "removed") {
      const { entries, noted } = this;
      const to = this.first + (this.end - this.base);
      for (
        let at = this.first + (Math.max(this.floor, this.base) - this.base);
        at < to;
        at++
      ) {
        noted[entries[at]!] = 0;
      }
    }
    this.floor = this.end;
    this.moved();
  }

  /** Drops the entries every reader has visited. */
  moved(): void {
    // Not in a transaction: a rollback puts readers back where they were,
    // and they need the entries they had visited to be there still.
    if (this.world._recording) {
      return;
    }
    let min = this.end;
    for (const cursor of this.cursors) {
      if (cursor.at < min) {
        min = cursor.at;
      }
    }
    if (min > this.base) {
      this.first += min - this.base;
      this.base = min;
    }
    if (this.base === this.end) {
      this.first = 0;
    }
  }

  /** Drops every entry made since the transaction began. */
  rollback(): void {
    const kept = this.first + (this.txEnd - this.base);
    if (this.kind !== "removed") {
      for (let at = this.first + (this.end - this.base) - 1; at >= kept; at--) {
        // Its entity is logged afresh the next time it is written.
        this.noted[this.entries[at]!] = 0;
      }
    }
    this.end = this.txEnd;
    // A visit inside the transaction went to an end that is gone.
    if (this.floor > this.end) {
      this.floor = this.end;
    }
    // A reader that was new in the transaction started at an end that is gone.
    for (const cursor of this.cursors) {
      if (cursor.at > this.end) {
        cursor.at = this.end;
      }
    }
  }

  /** Returns what the readers `keep` accepts have yet to visit, for a save. */
  save(keep: (key: string) => boolean): SavedChanges | undefined {
    const readers: Record<string, number> = {};
    let from = this.end;
    let any = false;
    for (const cursor of this.cursors) {
      if (!cursor.fresh && keep(cursor.key)) {
        any = true;
        from = Math.min(from, Math.max(cursor.at, this.base));
      }
    }
    if (!any) {
      return undefined;
    }
    for (const cursor of this.cursors) {
      if (!cursor.fresh && keep(cursor.key)) {
        readers[cursor.key] = Math.max(cursor.at, this.base) - from;
      }
    }
    const start = this.first + (from - this.base);
    return {
      component: this.def.name,
      kind: this.kind,
      entries: Array.from(
        this.entries.subarray(start, this.first + (this.end - this.base))
      ),
      readers,
    };
  }

  /** Loads what a save held. The log must be new, with nothing logged in it yet. */
  restore(saved: SavedChanges): void {
    const { entries } = saved;
    const limit =
      this.kind === "removed" ? Number.MAX_SAFE_INTEGER + 1 : this.world._slots;
    this.entries = this.room(Math.max(64, entries.length * 2));
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (!Number.isInteger(entry) || entry < 0 || entry >= limit) {
        throw corrupt(
          `the changes it holds for "${this.def.name}" name an entity that cannot be`
        );
      }
      this.entries[i] = entry;
    }
    this.end = entries.length;
    for (const [key, visited] of Object.entries(saved.readers)) {
      if (!Number.isInteger(visited) || visited < 0 || visited > this.end) {
        throw corrupt(
          `a reader of the changes to "${this.def.name}" is further than they go`
        );
      }
      this.cursors.push({ at: visited, key, fresh: false, claimed: false });
    }
    this.moved();
  }
}

/**
 * The entities that lost a component since this reader last read, by `remove`
 * or by being despawned. Each removal is reported once, oldest first.
 *
 * @category Models
 */
export class RemovedReader {
  private readonly restored: number;

  /** @internal */
  constructor(
    private readonly world: World,
    private readonly log: ChangeLog,
    private readonly cursor: ChangeCursor
  ) {
    this.restored = world._restored;
  }

  /**
   * Returns the ids of the entities that lost the component since the last
   * call. An id whose entity was despawned is no longer alive; one that only
   * had the component removed still is.
   */
  read(): Entity[] {
    if (this.restored !== this.world._restored) {
      throw new Error(
        "A reader of removed components was used after its world was restored from a snapshot. Ask for it again: world.removed(component), or yield* the query."
      );
    }
    const { cursor, log } = this;
    const count = log.waiting(cursor.at);
    if (count === 0) {
      return [];
    }
    const ids = new Float64Array(count);
    log.copy(cursor.at, ids, 0);
    this.world._reading(cursor);
    cursor.at = log.end;
    this.world._read(log);
    return Array.from(ids) as Entity[];
  }
}

/**
 * What the running code declared it would read and write. While a world has
 * one, `world.guard`, it refuses anything undeclared at the point it is
 * attempted: a query, a singleton, a read or a write through the world, or a
 * command. Nothing is checked inside a loop.
 *
 * An app gives its world a guard before each system with declared access runs,
 * and removes it afterwards. With the storage core on its own, it is a way to
 * hold a piece of code to what it is meant to touch.
 *
 * @category Models
 */
export interface Guard {
  /** Who runs under it, for messages: `System "Movement"`. */
  readonly who: string;
  /** The closing advice of a refusal. */
  readonly advice: string;
  /**
   * Indexed by component id: true for a component that may be read. A singleton
   * is identified by its component. What may be written may also be read.
   */
  readonly reads: readonly (true | undefined)[];
  /** Indexed by a component's id: true for one that may be written. */
  readonly writes: readonly (true | undefined)[];
  /** The components that may be written: what a despawn is checked against. */
  readonly writeDefs: readonly ComponentDef[];
  /**
   * The queries that may be requested as is. A requested query found to be
   * within `reads` and `writes` is added.
   */
  readonly queries: Set<QuerySpec>;
}

/** Describes a query as text: how a save identifies a change query. */
const describeSpec = (spec: QuerySpec): string => {
  const names = (defs: readonly ComponentDef[] | undefined): string =>
    (defs ?? []).map((def) => def.name).join(",");
  // What it only reads, in the order of its terms, however it was said.
  const reads = spec.terms.filter(
    (def: ComponentDef) => spec.readDefs?.includes(def) === true
  );
  return `all(${names(spec.terms)}) with(${names(spec.withDefs)}) without(${names(spec.withoutDefs)}) changed(${names(spec.changedDefs)}) added(${names(spec.addedDefs)}) reads(${names(reads)})`;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * The components a query reads, in the order its loop is given them.
 *
 * @category Models
 */
export type Terms = readonly ComponentDef[];

/**
 * A description of a query, independent of any world. Any object with this
 * shape works; the Effect layer provides a yieldable, pipeable implementation.
 *
 * @category Models
 */
export interface QuerySpec<D extends Terms = Terms> {
  /** Components whose data the query reads or writes (table or sparse). */
  readonly terms: D;
  /** Extra components an entity must have (table or sparse). */
  readonly withDefs: readonly ComponentDef[];
  /** Components an entity must not have (table or sparse). */
  readonly withoutDefs: readonly ComponentDef[];
  /**
   * Components to watch for writes. With any of these or of `addedDefs`, the
   * query visits only the entities for which one of them changed since it last
   * visited: see `World.view`.
   */
  readonly changedDefs?: readonly ComponentDef[];
  /** Components to watch for being added. */
  readonly addedDefs?: readonly ComponentDef[];
  /**
   * The terms the query only reads. `each` hands out accessors for them whose
   * setters throw. `eachChunk` doesn't count their rows as written for the
   * change queries that watch them, and a transaction doesn't save their
   * columns, since there is nothing to restore.
   */
  readonly readDefs?: readonly ComponentDef[];
}

export type AccessorsOf<D extends Terms> = {
  [K in keyof D]: D[K] extends ComponentDef<infer S extends Schema, Storage>
    ? D[K] extends ReadOnlyTerm
      ? Readonly<ValueOf<S>>
      : ValueOf<S>
    : never;
};

/**
 * The columns of a sparse component. They aren't aligned with table rows, so
 * look up the row per entity:
 * `burning.columns.seconds[burning.indexOf(entity)]`.
 *
 * @category Models
 */
export interface SparseColumns<S extends Schema, C = ColumnsOf<S>> {
  readonly columns: C;
  /** The row of an entity in `columns`. Only meaningful for entities that have the component. */
  readonly indexOf: (entity: number) => number;
}

/**
 * The entity ids of a table's rows. Reading an element returns an `Entity`.
 *
 * @category Models
 */
export type EntityColumn = Float64Array & Readonly<Record<number, Entity>>;

export type ColumnSetsOf<D extends Terms> = {
  [K in keyof D]: D[K] extends ComponentDef<infer S extends Schema, infer St>
    ? St extends "sparse"
      ? SparseColumns<
          S,
          D[K] extends ReadOnlyTerm ? ReadonlyColumnsOf<S> : ColumnsOf<S>
        >
      : D[K] extends ReadOnlyTerm
        ? ReadonlyColumnsOf<S>
        : ColumnsOf<S>
    : never;
};

/**
 * A query that requires a sparse component can find its matches two ways:
 * collect and sort the component's members (cost grows with the number of
 * members), or mark them in a per-table mask and scan it (cost grows with the
 * number of rows). Measured with members in random order, sorting wins at
 * roughly 64 rows per member, so that is the threshold.
 */
const SORT_ROWS_PER_MEMBER = 64;

/**
 * Scanning a mask with the native `indexOf` costs about 55 ns per call but
 * almost nothing per byte; a JS loop costs about 1 ns per byte. Native wins
 * when the stretches it skips average more than a few dozen rows.
 */
const NATIVE_SCAN_ROWS_PER_EXCEPTION = 64;

const ROW_RANGE = 4_294_967_296; // 2^32: keys are `slot * ROW_RANGE + row`

/** What `each` hands out, and the loop's position, for one level of iteration. */
interface Loop {
  readonly accessors: Accessor[];
  /** For each term, what the callback of `each` receives. */
  readonly fields: object[];
  /** The loop's current row, for every term whose rows are a table's. */
  readonly row: Row;
  /** For each term, the row it reads, which for a sparse term is its own. */
  readonly rows: Row[];
  /**
   * The entities array of the table the table terms' accessors were last bound
   * to. A table that grows gets new arrays, including its entities array, so
   * this identifies both the table and that its columns haven't moved. Most
   * loops visit the same table every time, and don't need to rebind.
   */
  table: Float64Array | undefined;
  /** For each sparse term, the same for its set, identified by its members array. */
  readonly sets: (Uint32Array | undefined)[];
}

/** Scratch state for one level of nested iteration over the same view. */
interface Frame {
  /** Created by the first `each` at this level: a raw loop doesn't need it. */
  loop: Loop | undefined;
  /** Whether `loop` is for a frozen world, whose accessors only read. */
  readonly frozen: boolean;
  keys: Float64Array;
  /** For a change query, the entity indexes this iteration covers. */
  members: Members;
}

/**
 * Entity indexes to search for matches: the members of a sparse set, or what a
 * change query has yet to visit. An index may appear twice.
 */
interface Members {
  dense: Uint32Array;
  count: number;
}

type Callback = (...args: unknown[]) => void;
type OnRun = (table: Table, start: number, end: number) => void;

/**
 * A query bound to one world: what a system gets from `yield* SomeQuery`, to
 * iterate with `each`.
 *
 * @category Models
 */
export class QueryView<D extends Terms = Terms> {
  /** The world's restore count when this view was created. */
  private readonly restored: number;
  private readonly tables: Table[] = [];
  /** Indexed by table index: the position in `tables`, or -1 when the table doesn't match. */
  private readonly slotOf: number[] = [];
  private scanned = 0;

  private readonly n: number;
  /** Per term: its table component id, or -1 when the term is sparse. */
  private readonly termTableId: number[] = [];
  /** Per term: its sparse set, or undefined when the term is a table component. */
  private readonly termSet: (SparseSet | undefined)[] = [];
  /** The indexes of the sparse terms among the terms. */
  private readonly sparseTerms: number[] = [];
  /** For each term, true when the query only reads it. */
  private readonly termRead: boolean[] = [];
  private readonly hasSparseTerms: boolean;

  private readonly requiredIds: number[] = [];
  private readonly excludedIds: number[] = [];
  private readonly sparseWith: SparseSet[] = [];
  private readonly sparseWithout: SparseSet[] = [];
  /** True when some condition must be checked per entity. */
  private readonly filtered: boolean;

  /**
   * One byte per row, per matching table: 1 means "skip this row". Between
   * iterations, every byte holds `maskBase`; an iteration marks the exceptions,
   * walks the runs of 0s, then restores the exceptions.
   */
  private readonly masks: (Uint8Array | undefined)[] = [];
  /** 1 when a sparse component is required (rows are skipped unless marked), else 0. */
  private readonly maskBase: 0 | 1;

  /** How many mask bytes the current outermost iteration marked. */
  private exceptions = 0;

  private readonly frames: Frame[] = [];
  /** Like `frames`, for a frozen world: with read-only accessors. */
  private readonly frozenFrames: Frame[] = [];
  private depth = 0;

  /**
   * For a change query, its position in the log of each component and kind of
   * change it watches. Empty for any other query.
   */
  private readonly watches: { log: ChangeLog; cursor: ChangeCursor }[] = [];
  private readonly watching: boolean;
  /** Scratch space for `count`, which peeks without visiting. */
  private peek: Frame | undefined;

  /** For each term, the log its writes are recorded in, when some query watches it. */
  private termLog: (ChangeLog | undefined)[] = [];
  private notes = false;
  /** The value of `world._watched` that `termLog` was computed for. */
  private notesAt = -1;

  /** @internal Test hook: force one strategy for queries that require a sparse component. */
  _path: "auto" | "sorted" | "mask" = "auto";
  /** @internal The strategy the last iteration used. */
  _lastPath: "dense" | "sorted" | "mask" = "dense";

  /** @internal */
  constructor(
    private readonly world: World,
    readonly spec: QuerySpec<D>,
    /** For a change query, how a save identifies this reader. */
    key = ""
  ) {
    this.restored = world._restored;
    const requireSparse = (def: ComponentDef): SparseSet => {
      const set = world._sparse(def);
      if (!this.sparseWith.includes(set)) {
        this.sparseWith.push(set);
      }
      return set;
    };
    for (const def of spec.readDefs ?? []) {
      if (!spec.terms.includes(def)) {
        throw new Error(
          `A query says it only reads "${def.name}", which is not one of its terms: ${spec.terms.map((term) => term.name).join(", ") || "it has none"}.`
        );
      }
    }
    for (const def of spec.terms) {
      this.termRead.push(spec.readDefs?.includes(def) === true);
      if (def.storage === "table") {
        this.requiredIds.push(def.id);
        this.termTableId.push(def.id);
        this.termSet.push(undefined);
      } else {
        // Reading a sparse component's data implies requiring it.
        this.sparseTerms.push(this.termTableId.length);
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
    // Watching a component implies requiring it.
    const watch = (
      defs: readonly ComponentDef[] | undefined,
      kind: ChangeKind
    ): void => {
      for (const def of defs ?? []) {
        if (def.storage !== "table") {
          requireSparse(def);
        } else if (!this.requiredIds.includes(def.id)) {
          this.requiredIds.push(def.id);
        }
        const log = world._log(def, kind);
        if (!this.watches.some((each) => each.log === log)) {
          this.watches.push({ log, cursor: log.cursor(key) });
        }
      }
    };
    watch(spec.changedDefs, "changed");
    watch(spec.addedDefs, "added");
    this.watching = this.watches.length > 0;
    this.n = spec.terms.length;
    this.hasSparseTerms = this.termSet.some((set) => set !== undefined);
    this.filtered =
      this.watching || this.sparseWith.length + this.sparseWithout.length > 0;
    // A change query skips every row but the ones it marks, as a query that
    // requires a sparse component does.
    this.maskBase = this.watching || this.sparseWith.length > 0 ? 1 : 0;
  }

  /** Picks up tables created since the last run. */
  private refresh(): void {
    if (this.restored !== this.world._restored) {
      throw new Error(
        "A query's view was used after its world was restored from a snapshot. What it held is gone with the tables it was made of. Ask for it again: world.view(spec), or yield* the query, as a system does every tick."
      );
    }
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
   * Starts an iteration. Nested iteration over the same view (for example,
   * comparing every pair of entities) gets its own accessors and scratch space
   * per level, so the inner loop can't disturb the outer one.
   */
  private enter(): Frame {
    this.refresh();
    const { world } = this;
    if (this.notesAt !== world._watched && this.depth === 0) {
      // A component of this query has come to be watched, or this is the
      // first iteration: its terms get accessors that note their writes.
      this.notesAt = world._watched;
      // A term the query only reads is not written, so nothing is noted.
      this.termLog = this.spec.terms.map((def, k) =>
        this.termRead[k] ? undefined : world._changed[def.id]
      );
      this.notes = this.termLog.some((log) => log !== undefined);
      this.frames.length = 0;
    }
    world._iterating++;
    const depth = this.depth++;
    return world._frozen
      ? (this.frozenFrames[depth] ??= this.makeFrame(true))
      : (this.frames[depth] ??= this.makeFrame(false));
  }

  private makeFrame(frozen: boolean): Frame {
    return {
      loop: undefined,
      frozen,
      keys: new Float64Array(64),
      members: { dense: new Uint32Array(64), count: 0 },
    };
  }

  /** Creates the accessors for a level of iteration, the first time `each` needs them. */
  private makeLoop(frozen: boolean): Loop {
    // The terms that are in the table share the row the loop is at. A
    // sparse term has its rows elsewhere, and a row of its own.
    const row: Row = { i: 0 };
    const rows = this.termSet.map((set) =>
      set === undefined ? row : { i: 0 }
    );
    const accessors = this.spec.terms.map((def, k) =>
      makeAccessor(
        def,
        frozen
          ? "frozen"
          : this.termRead[k]
            ? "reads"
            : this.termLog[k] === undefined
              ? "writes"
              : "notes",
        rows[k]!
      )
    );
    return {
      accessors,
      fields: accessors.map((accessor) => accessor.fields),
      row,
      rows,
      table: undefined,
      sets: [],
    };
  }

  private leave(): void {
    this.depth--;
    this.world._left();
  }

  // --- change queries: what there is to visit ----------------------------------

  /**
   * Fills `members` with the entity indexes this change query has yet to visit,
   * possibly with duplicates, and returns how many. With `visit`, they then
   * count as visited.
   *
   * The first time, that is every entity of the matching tables: the logs only
   * know what happened since they started, and to a query that has never run
   * everything is new.
   */
  private gather(members: Members, visit: boolean): number {
    const { watches, world } = this;
    let fresh = false;
    let count = 0;
    for (let w = 0; w < watches.length; w++) {
      const { cursor, log } = watches[w]!;
      fresh ||= cursor.fresh;
      count += log.waiting(cursor.at);
    }
    if (fresh) {
      count = 0;
      for (let t = 0; t < this.tables.length; t++) {
        count += this.tables[t]!.count;
      }
    }
    if (members.dense.length < count) {
      members.dense = new Uint32Array(
        Math.max(count, members.dense.length * 2)
      );
    }
    const { dense } = members;
    let at = 0;
    if (fresh) {
      for (let t = 0; t < this.tables.length; t++) {
        const { count: rows, entities } = this.tables[t]!;
        for (let row = 0; row < rows; row++) {
          dense[at++] = entities[row]! & INDEX_MASK;
        }
      }
    } else {
      for (let w = 0; w < watches.length; w++) {
        const { cursor, log } = watches[w]!;
        log.copy(cursor.at, dense, at);
        at += log.waiting(cursor.at);
      }
    }
    members.count = count;
    if (visit) {
      for (let w = 0; w < watches.length; w++) {
        const { cursor, log } = watches[w]!;
        if (cursor.fresh || cursor.at !== log.end) {
          world._reading(cursor);
          cursor.fresh = false;
          cursor.at = log.end;
          world._read(log);
        }
      }
    }
    return count;
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

    let smallest: Members | undefined;
    if (this.watching) {
      // What changed is where to look: nothing else is visited at all.
      if (this.gather(frame.members, true) === 0) {
        return;
      }
      smallest = frame.members;
    } else {
      for (let s = 0; s < this.sparseWith.length; s++) {
        const set = this.sparseWith[s]!;
        if (smallest === undefined || set.count < smallest.count) {
          smallest = set;
        }
      }
    }
    // A change query nested in itself has other entities to visit than the
    // marks in place are for, so it sorts.
    if (
      smallest !== undefined &&
      ((this.watching && this.depth > 1) || this.shouldSort(smallest))
    ) {
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

  private shouldSort(smallest: Members): boolean {
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
  private mark(smallest: Members | undefined): number {
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

  /** Resets every byte `mark` could have touched to `maskBase`. */
  private unmark(smallest: Members | undefined): void {
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

  /**
   * For very rare required components: collects the matches, sorts them, and
   * merges them into runs.
   */
  private sortedRuns(frame: Frame, smallest: Members, onRun: OnRun): void {
    const m = this.sortedKeys(frame, smallest);
    const { keys } = frame;
    let k = 0;
    while (k < m) {
      const slot = Math.floor(keys[k]! / ROW_RANGE);
      const start = keys[k]! - slot * ROW_RANGE;
      let end = start + 1;
      k++;
      // A row that is there twice (a change query's entity, logged twice)
      // has the same key as the one before it.
      while (k < m) {
        const key = keys[k]!;
        if (key === slot * ROW_RANGE + end) {
          end++;
        } else if (key !== slot * ROW_RANGE + end - 1) {
          break;
        }
        k++;
      }
      onRun(this.tables[slot]!, start, end);
    }
  }

  /**
   * Writes a key for each match in `smallest` into `frame.keys`, in query visit
   * order, and returns how many.
   */
  private sortedKeys(frame: Frame, smallest: Members): number {
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
    return m;
  }

  // --- transactions: a loop may write anything it is handed ---------------------

  /** Saves the columns of this query's table terms in one table. */
  private saveTableTerms(table: Table): void {
    for (let k = 0; k < this.n; k++) {
      const id = this.termTableId[k]!;
      // What is only read is not written, and need not be put back.
      if (id !== -1 && !this.termRead[k]) {
        this.world._saveColumns(
          this.spec.terms[k]!,
          table.columns[id]!,
          table.count
        );
      }
    }
  }

  /** Saves the columns of this query's sparse terms. */
  private saveSparseTerms(): void {
    for (let k = 0; k < this.n; k++) {
      const set = this.termSet[k];
      if (set !== undefined && !this.termRead[k]) {
        this.world._saveColumns(set.def, set.columns, set.count);
      }
    }
  }

  // --- each: one callback per entity, through accessors -----------------------

  /**
   * Calls `fn` once per matching entity, with one accessor per term.
   *
   * The accessors are reused between calls: read and write through them inside
   * the callback, but don't keep references to them.
   */
  each(fn: (...args: [...AccessorsOf<D>, entity: Entity]) => void): void {
    const frame = this.enter();
    try {
      const f = fn as Callback;
      const loop = (frame.loop ??= this.makeLoop(frame.frozen));
      const acc = loop.accessors;
      // Sparse columns are replaced when a set grows, and its members'
      // array with them: an accessor is pointed at them again only then.
      // An accessor that notes its writes is told whose row each is, and
      // where to note it; any other takes the columns and ignores the rest.
      const { termLog } = this;
      for (let k = 0; k < this.n; k++) {
        const set = this.termSet[k];
        if (set !== undefined && loop.sets[k] !== set.dense) {
          acc[k]!.bind(set.columns, set.dense, termLog[k]);
          loop.sets[k] = set.dense;
        }
      }
      const { world } = this;
      if (world._recording) {
        this.saveSparseTerms();
      }
      let bound: Table | undefined;
      this.runs(frame, (table, start, end) => {
        if (table !== bound) {
          // Unless they are pointed at it already, from the last time.
          if (loop.table !== table.entities) {
            for (let k = 0; k < this.n; k++) {
              const id = this.termTableId[k];
              if (id !== -1) {
                acc[k]!.bind(table.columns[id!]!, table.entities, termLog[k]);
              }
            }
            loop.table = table.entities;
          }
          // Once per table, never per entity.
          if (world._recording) {
            this.saveTableTerms(table);
          }
          bound = table;
        }
        if (this.hasSparseTerms) {
          this.visitSparse(f, loop, table.entities, start, end);
        } else {
          this.visit(f, loop, table.entities, start, end);
        }
      });
    } finally {
      this.leave();
    }
  }

  /** The hot loop: rows `[start, end)` of one table, all terms row-aligned. */
  private visit(
    f: Callback,
    loop: Loop,
    ents: Float64Array,
    start: number,
    end: number
  ): void {
    const { n } = this;
    const { fields, row } = loop;
    // Moving on is one assignment, whatever the number of terms: they all
    // read the row from the same place.
    // Specialised by arity so the callback is called with a fixed number
    // of arguments (a spread call here costs roughly 3x).
    if (n === 1) {
      const a = fields[0]!;
      for (let i = start; i < end; i++) {
        row.i = i;
        f(a, ents[i]);
      }
    } else if (n === 2) {
      const a = fields[0]!;
      const b = fields[1]!;
      for (let i = start; i < end; i++) {
        row.i = i;
        f(a, b, ents[i]);
      }
    } else if (n === 3) {
      const a = fields[0]!;
      const b = fields[1]!;
      const c = fields[2]!;
      for (let i = start; i < end; i++) {
        row.i = i;
        f(a, b, c, ents[i]);
      }
    } else {
      const args: unknown[] = Array.from({ length: n + 1 });
      for (let k = 0; k < n; k++) {
        args[k] = fields[k];
      }
      for (let i = start; i < end; i++) {
        row.i = i;
        args[n] = ents[i];
        f.apply(undefined, args);
      }
    }
  }

  /** Like `visit`, but sparse terms look up their own row per entity. */
  private visitSparse(
    f: Callback,
    loop: Loop,
    ents: Float64Array,
    start: number,
    end: number
  ): void {
    const { n, sparseTerms, termSet } = this;
    const { fields, row, rows } = loop;
    for (let i = start; i < end; i++) {
      const entity = ents[i]!;
      row.i = i;
      for (let s = 0; s < sparseTerms.length; s++) {
        const k = sparseTerms[s]!;
        rows[k]!.i = termSet[k]!.sparse[entity & INDEX_MASK]!;
      }
      if (n === 1) {
        f(fields[0], entity);
      } else if (n === 2) {
        f(fields[0], fields[1], entity);
      } else if (n === 3) {
        f(fields[0], fields[1], fields[2], entity);
      } else {
        f(...fields, entity);
      }
    }
  }

  // --- eachChunk: raw columns, the caller writes the loop ---------------------

  /**
   * The fast path. Calls `fn` with raw columns and a range of rows `[start,
   * end)` that all match; you write the loop yourself:
   *
   *   view.eachChunk((start, end, pos, vel) => {
   *     for (let i = start; i < end; i++) pos.x[i] += vel.x[i] * dt
   *   })
   *
   * A query without sparse conditions gets one chunk per table. With sparse
   * conditions, each table is split into runs of consecutive matching rows.
   *
   * Sparse data terms arrive as `{ columns, indexOf }`, because their rows
   * don't line up with the table's. After the columns comes `entities`, the ids
   * of the table's rows.
   *
   * Under `noUncheckedIndexedAccess`, a read from a column is `number |
   * undefined` and needs an assertion, `pos.x[i]!`. The raw path can't avoid
   * it: a checked read would cost a call per read.
   *
   * Raw columns can't report which rows were written. When a change query
   * watches one of this query's terms, every row handed out counts as written,
   * unless the query declares the term read-only (`readDefs`). For the same
   * reason, a change query can't hand out a component it watches unless it
   * declares it read-only: that throws. In a frozen world nothing is written,
   * so neither applies.
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
      const cols: unknown[] = Array.from({ length: n });
      for (let k = 0; k < n; k++) {
        cols[k] = this.termSet[k];
      }
      const { world } = this;
      // A frozen world is only read, so nothing a raw loop is handed there
      // counts as written.
      const noting = this.notes && !world._frozen;
      if (noting && this.watching) {
        this.refuseOwnWrites();
      }
      if (world._recording) {
        this.saveSparseTerms();
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
          if (world._recording) {
            this.saveTableTerms(table);
          }
          bound = table;
        }
        const ents = table.entities;
        if (noting) {
          // Raw columns cannot say which rows were written, so every row
          // that is handed out counts as written.
          for (let k = 0; k < n; k++) {
            this.termLog[k]?.noteRows(ents, start, end);
          }
        }
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

  /**
   * Refuses a change query that hands out, as raw columns, a component it
   * watches for writes, unless it declares the component read-only: it would
   * mistake its own visit for a change, and visit the same entities again every
   * time.
   */
  private refuseOwnWrites(): void {
    for (let k = 0; k < this.n; k++) {
      const log = this.termLog[k];
      if (log !== undefined && this.watches.some((each) => each.log === log)) {
        throw new Error(
          `eachChunk() was called on a query that watches "${log.def.name}" for changes and also hands it out. Raw columns cannot tell a read from a write, so every row handed out counts as written, and the query would see its own visit as a change every time. Visit it with each(), whose accessors note only the rows they assign to; or, if the loop only reads "${log.def.name}", say so with Query.reads (readDefs); or take it out of the query's terms.`
        );
      }
    }
  }

  // --- conveniences -----------------------------------------------------------

  /**
   * Returns the number of matching entities. For a change query, how many it
   * has yet to visit: counting isn't visiting.
   */
  count(): number {
    this.refresh();
    if (this.watching) {
      const peek = (this.peek ??= this.makeFrame(false));
      if (this.gather(peek.members, false) === 0) {
        return 0;
      }
      const m = this.sortedKeys(peek, peek.members);
      let distinct = 0;
      for (let k = 0; k < m; k++) {
        if (k === 0 || peek.keys[k] !== peek.keys[k - 1]) {
          distinct++;
        }
      }
      return distinct;
    }
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

  /**
   * Returns the matching entities in iteration order, as a new array. For a
   * change query, this is a visit, like `each`.
   */
  entities(): Entity[] {
    const out: Entity[] = [];
    if (this.watching) {
      const frame = this.enter();
      try {
        this.runs(frame, (table, start, end) => {
          for (let i = start; i < end; i++) {
            out.push(table.entities[i] as Entity);
          }
        });
      } finally {
        this.leave();
      }
      return out;
    }
    this.refresh();
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

/**
 * The storage core: entities, the tables of their components, sparse sets,
 * singletons and change logs. Plain synchronous code with no Effect; an app
 * holds one and provides it to systems as the `World` service.
 *
 * @category Models
 */
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
  /** For each slot, how many times it was allocated and freed. */
  private gens = new Uint32Array(1024);
  private readonly freeList: number[] = [];
  private nextIndex = 0;
  private alive = 0;

  /** @internal */
  readonly tables: Table[] = [];
  private readonly tableByKey = new Map<string, Table>();
  private readonly sparseById = new Map<number, SparseSet>();
  private readonly sparseList: SparseSet[] = [];
  private readonly views = new Map<QuerySpec, QueryView>();
  private readonly componentsByName = new Map<string, ComponentDef>();
  /** Indexed by component id: true once registered, so the common check is a single read. */
  private readonly registered: (true | undefined)[] = [];
  /** Indexed by component id: what `hash` folds in for the component itself. */
  private readonly shapes: number[] = [];
  /** The sparse sets in order of component name, rebuilt when one is created. */
  private sparseByName: SparseSet[] | undefined;
  /** Scratch space for `hash`: one state per member of a sparse set. */
  private memberStates = new Int32Array(64);

  /** @internal Depth of query iteration in progress. */
  _iterating = 0;
  /**
   * @internal How many times `restore` has put a snapshot back. A view
   * made before the last of them holds tables that are gone.
   */
  _restored = 0;

  /**
   * The current reader: the reader a change query, or `removed`, belongs to
   * when none is given. An app sets this before each system and handler runs,
   * which gives each its own position in every change log.
   */
  reader: string | undefined;
  /**
   * What the running code declared it would read and write, if it declared
   * anything: the world refuses the rest. See `Guard`.
   */
  guard: Guard | undefined;
  /** @internal Indexed by component id: the log of writes, when a query watches them. */
  readonly _changed: (ChangeLog | undefined)[] = [];
  private readonly addedLogs: (ChangeLog | undefined)[] = [];
  private readonly removedLogs: (ChangeLog | undefined)[] = [];
  /** Every change log, in the order they were started. */
  private readonly logs: ChangeLog[] = [];
  /** The `changed` logs, which are the ones a transaction can add to. */
  private readonly writeLogs: ChangeLog[] = [];
  /** @internal How many `changed` logs there are: a view's accessors depend on it. */
  _watched = 0;
  /** Logs started while a query was iterating, whose accessors record nothing. */
  private lateLogs: ChangeLog[] = [];
  private readonly watchViews = new Map<QuerySpec, Map<string, QueryView>>();
  private readonly watchViewsByKey = new Map<string, QueryView>();
  private readonly removedReaders = new Map<string, RemovedReader>();
  /** Indexed by component id: which entities point at which, once a relation is stored. */
  private readonly relations: (RelationIndex | undefined)[] = [];
  /** The same, in order of name: the order a despawn processes them in. */
  private relationList: RelationIndex[] = [];
  /** Indexed by component id. */
  private readonly singles: (Single | undefined)[] = [];
  /** The singletons in order of name, rebuilt when one is created. */
  private singlesByName: Single[] | undefined;
  /**
   * In a transaction, the singletons that were written, and whether each had
   * been written before.
   */
  private readonly savedSingles: {
    readonly single: Single;
    readonly written: boolean;
  }[] = [];
  /** In a transaction, the readers that moved, and their previous positions. */
  private readonly movedReaders: {
    readonly cursor: ChangeCursor;
    readonly at: number;
    readonly fresh: boolean;
  }[] = [];

  /**
   * The world's random number generator. Its state is part of the world, so
   * everything random in a simulation comes from here.
   */
  readonly random: Rng;

  /** @internal True between `begin` and `commit` or `rollback`. */
  _recording = false;
  /** @internal True between `freeze` and `thaw`. */
  _frozen = false;
  /** What a rollback restores, in the order it was saved. */
  private readonly saved: Saved[] = [];
  /** The column sets saved whole, so each is copied once. */
  private readonly savedWhole = new Set<Columns>();
  /**
   * The copies from earlier transactions, kept per column set to be overwritten
   * by the next one. Allocating them anew cost more than copying into them: a
   * handler that loops over a table every time it runs would otherwise allocate
   * that table's size on every action.
   */
  private readonly spare = new WeakMap<Columns, unknown[]>();
  private readonly savedRandom = new Uint32Array(4);
  /** The random generator's state when the world was frozen. */
  private readonly frozenRandom = new Uint32Array(4);

  /** @param options.seed where the random sequence starts; defaults to 0. */
  constructor(options?: { readonly seed?: number }) {
    this.random = new Rng(options?.seed ?? 0);
  }

  /** The number of live entities. */
  get entityCount(): number {
    return this.alive;
  }

  /** @internal How many entity slots have ever been used: every index is below it. */
  get _slots(): number {
    return this.nextIndex;
  }

  // --- entities ------------------------------------------------------------

  /**
   * Returns whether the entity an id refers to is alive. Once the entity is
   * despawned it is false for good: its slot is reused with another generation,
   * and so under another id.
   */
  isAlive(entity: Entity): boolean {
    const index = entityIndex(entity);
    // The generation, compared without rounding it down: a number that is
    // no id, which has a part below its index's bits or none at all, is the
    // generation of no slot.
    return (
      index < this.nextIndex &&
      this.recTable[index] !== FREE &&
      this.gens[index] === (entity - index) / SLOTS
    );
  }

  /**
   * Allocates an entity id without placing it in a table. Used by
   * CommandBuffer so `spawn` can return an id before the spawn is applied.
   * @internal
   */
  _reserve(): Entity {
    if (this._frozen) {
      throw new Error(frozenWrite("A spawn"));
    }
    let index: number;
    this._reservedFresh = this.freeList.length === 0;
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

  /** @internal Whether the last `_reserve` took an index never used before. */
  _reservedFresh = false;

  /**
   * Gives back an id that `_reserve` handed out and that was never placed,
   * leaving the world as if it had not been asked: the same ids to come, with
   * the same generations. That is exact when ids are given back in the
   * reverse of the order they were reserved in, with nothing else spawned or
   * despawned in between; otherwise the slot is freed like any other.
   * @internal
   */
  _release(entity: Entity, fresh: boolean): void {
    const index = entityIndex(entity);
    if (!this.isAlive(entity) || this.recTable[index] !== NOT_PLACED) {
      return;
    }
    if (fresh && index !== this.nextIndex - 1) {
      this.despawn(entity);
      return;
    }
    this.recTable[index] = FREE;
    this.alive--;
    if (fresh) {
      this.nextIndex--;
    } else {
      this.freeList.push(index);
    }
    // Something may have been told to point at the id while it was queued.
    if (this.relationList.length > 0) {
      const pending: Entity[] = [];
      this.orphan(index, pending);
      this.despawnAll(pending);
    }
  }

  private growRecords(): void {
    const size = this.recTable.length * 2;
    const recTable = new Int32Array(size).fill(FREE);
    recTable.set(this.recTable);
    this.recTable = recTable;
    const recRow = new Int32Array(size);
    recRow.set(this.recRow);
    this.recRow = recRow;
    const gens = new Uint32Array(size);
    gens.set(this.gens);
    this.gens = gens;
    for (const log of this.logs) {
      log.grow(size);
    }
    for (const relation of this.relationList) {
      relation.grow(size);
    }
  }

  /** @internal */
  _place(entity: Entity, inputs: readonly ComponentInput[]): void {
    const index = entityIndex(entity);
    // Later inputs win when the same component is given twice.
    const byId = new Map<number, ComponentInput>();
    for (const input of inputs) {
      byId.set((isComponentDef(input) ? input : input.def).id, input);
    }
    const tableDefs: ComponentDef[] = [];
    for (const input of byId.values()) {
      const def = isComponentDef(input) ? input : input.def;
      if (def.storage === "table") {
        tableDefs.push(def);
      }
    }
    tableDefs.sort((a, b) => a.id - b.id);
    const table = this.tableFor(tableDefs);
    const row = table.push(entity);
    let related: ComponentValue[] | undefined;
    for (const input of byId.values()) {
      const def = isComponentDef(input) ? input : input.def;
      const value = isComponentDef(input) ? undefined : input.value;
      if (def.storage === "table") {
        writeRow(def, table.columns[def.id]!, row, value);
      } else {
        this._sparse(def).add(index, value);
      }
      if (this.logs.length > 0) {
        this.addedLogs[def.id]?.note(index);
        this._changed[def.id]?.note(index);
      }
      if (def.relation !== undefined) {
        (related ??= []).push(input as ComponentValue);
      }
    }
    this.recTable[index] = table.index;
    this.recRow[index] = row;
    if (related !== undefined) {
      this.placeRelations(entity, related);
    }
  }

  /** Records the relations an entity was spawned with. */
  private placeRelations(entity: Entity, related: ComponentValue[]): void {
    const index = entityIndex(entity);
    let gone = false;
    const dangling: ComponentDef[] = [];
    for (const { def, value } of related) {
      const target = value.target as Entity;
      if (this.isAlive(target)) {
        this.relationOf(def).link(index, entityIndex(target));
      } else if (def.relation === "despawn") {
        gone = true;
      } else {
        dangling.push(def);
      }
    }
    // A target that is gone already: what its despawn would have done.
    if (gone) {
      this.despawn(entity);
    } else {
      for (const def of dangling) {
        this.remove(entity, def);
      }
    }
  }

  /**
   * Creates an entity with these components and returns its id. Like every
   * structural change, it throws while a query is iterating and inside a
   * transaction: queue it on a `CommandBuffer` there.
   */
  spawn(...inputs: readonly ComponentInput[]): Entity {
    this.assertNotIterating("spawn");
    if (this.guard !== undefined) {
      this._guardWrites(inputs, "spawned an entity with");
    }
    // Before an id is reserved, so a refused component leaves nothing behind.
    this._registerAll(inputs);
    const entity = this._reserve();
    this._place(entity, inputs);
    return entity;
  }

  /**
   * Despawns an entity. Entities that point at it with a relation are handled
   * as the relation specifies: despawned too, recursively, or stripped of the
   * relation. Relations are processed in order of name, and the entities
   * pointing at it in order of index, so the same world always loses the same
   * entities in the same order.
   */
  despawn(entity: Entity): boolean {
    this.assertNotIterating("despawn");
    if (!this.isAlive(entity)) {
      return false;
    }
    if (this.guard !== undefined) {
      this._guardDespawn(entity);
    }
    if (this.relationList.length === 0) {
      this.despawnOne(entity);
    } else {
      this.despawnAll([entity]);
    }
    return true;
  }

  /**
   * Despawns the entities in `pending`, last first, along with everything their
   * removal takes with it. It uses a list rather than recursion, since a chain
   * of parents can be as long as the world is large.
   */
  private despawnAll(pending: Entity[]): void {
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (this.isAlive(next)) {
        this.despawnOne(next);
        this.orphan(entityIndex(next), pending);
      }
    }
  }

  /**
   * Handles the removal of the entity at `index`: entities that pointed at it
   * lose the relation, or are added to `pending` to be despawned, lowest index
   * on top.
   */
  private orphan(index: number, pending: Entity[]): void {
    const doomed: Entity[] = [];
    for (const relation of this.relationList) {
      // Each is unlinked as it loses the relation, or is despawned.
      for (const source of relation.sources(index)) {
        const holder = makeEntity(source, this.gens[source]!);
        if (relation.def.relation === "despawn") {
          doomed.push(holder);
        } else {
          this.removeOne(holder, relation.def);
        }
      }
    }
    for (let i = doomed.length - 1; i >= 0; i--) {
      pending.push(doomed[i]!);
    }
  }

  /** Despawns one live entity, and nothing else. */
  private despawnOne(entity: Entity): void {
    const index = entityIndex(entity);
    const tableIndex = this.recTable[index];
    const { removedLogs } = this;
    if (tableIndex !== NOT_PLACED) {
      const table = this.tables[tableIndex!]!;
      if (removedLogs.length > 0) {
        for (const def of table.defs) {
          removedLogs[def.id]?.push(entity);
        }
      }
      const row = this.recRow[index]!;
      const moved = table.swapRemove(row);
      if (moved !== undefined) {
        this.recRow[entityIndex(moved)] = row;
      }
    }
    for (const set of this.sparseList) {
      if (set.remove(index)) {
        removedLogs[set.def.id]?.push(entity);
      }
    }
    this.recTable[index] = FREE;
    // The slot is given out again with its next generation, so that the id
    // which just died names nobody. When the last generation has been used
    // the slot is given out no more: no id is ever given out twice.
    const next = this.gens[index]! + 1;
    this.gens[index] = next;
    if (next < GENERATIONS) {
      this.freeList.push(index);
    }
    this.alive--;
    // It points at nothing now.
    for (const relation of this.relationList) {
      relation.unlink(index);
    }
  }

  // --- components ----------------------------------------------------------

  /**
   * Adds a component to an entity or, given a value, overwrites the existing
   * one. This is also how a relation gets a new target. Returns false when the
   * entity is gone, or when a relation's target is: whatever that target's
   * despawn would have done then happens at once.
   */
  add(entity: Entity, input: ComponentInput): boolean {
    this.assertNotIterating("add");
    if (this.guard !== undefined) {
      this._guardWrites([input], "added");
    }
    if (!this.isAlive(entity)) {
      return false;
    }
    const index = entityIndex(entity);
    const def = isComponentDef(input) ? input : input.def;
    const value = isComponentDef(input) ? undefined : input.value;
    if (def.relation === undefined) {
      return this.addOne(index, entity, def, value);
    }
    if (value === undefined) {
      throw targetless(def);
    }
    const target = value.target as Entity;
    if (!this.isAlive(target)) {
      // A target that is gone already: what its despawn would have done.
      if (def.relation === "despawn") {
        this.despawn(entity);
      } else {
        this.removeOne(entity, def);
      }
      return false;
    }
    this.addOne(index, entity, def, value);
    this.relationOf(def).link(index, entityIndex(target));
    return true;
  }

  /** Adds a component, or overwrites one the entity has, and records it. */
  private addOne(
    index: number,
    entity: Entity,
    def: ComponentDef,
    value: Readonly<Record<string, unknown>> | undefined
  ): boolean {
    if (def.storage === "sparse") {
      const set = this._sparse(def);
      const had = set.has(index);
      set.add(index, value);
      // A component the entity already had is written, if a value came.
      if (!had) {
        this.addedLogs[def.id]?.note(index);
      }
      if (!had || value !== undefined) {
        this._changed[def.id]?.note(index);
      }
      return true;
    }
    const from = this.placedTable(index);
    if (from.ids.has(def.id)) {
      if (value !== undefined) {
        writeRow(def, from.columns[def.id]!, this.recRow[index]!, value);
        this._changed[def.id]?.note(index);
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
    this.addedLogs[def.id]?.note(index);
    this._changed[def.id]?.note(index);
    return true;
  }

  /** Removes a component from an entity. Returns false when it didn't have it. */
  remove(entity: Entity, def: ComponentDef): boolean {
    this.assertNotIterating("remove");
    if (this.guard !== undefined) {
      this._guardWrites([def], "removed");
    }
    if (!this.isAlive(entity)) {
      return false;
    }
    return this.removeOne(entity, def);
  }

  /** Removes a component from a live entity. */
  private removeOne(entity: Entity, def: ComponentDef): boolean {
    const index = entityIndex(entity);
    if (def.relation !== undefined) {
      this.relations[def.id]?.unlink(index);
    }
    if (def.storage === "sparse") {
      if (!this._sparse(def).remove(index)) {
        return false;
      }
      this.removedLogs[def.id]?.push(entity);
      return true;
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
    this.removedLogs[def.id]?.push(entity);
    return true;
  }

  /** Returns whether an entity is alive and has a component. */
  has(entity: Entity, def: ComponentDef): boolean {
    if (this.guard !== undefined && this.guard.reads[def.id] !== true) {
      this.refuse(`read "${def.name}" through the world`, "read");
    }
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

  /** Reads a component as a new plain object. Convenient, but not for hot loops. */
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
      return readRow(def, set.columns, set.sparse[index]!) as ValueOf<S>;
    }
    return readRow(
      def,
      this.tables[this.recTable[index]!]!.columns[def.id]!,
      this.recRow[index]!
    ) as ValueOf<S>;
  }

  /**
   * Writes some or all fields of a component the entity already has. A
   * relation's `target` can't be written this way, and throws: add the relation
   * again.
   */
  set<S extends Schema>(
    entity: Entity,
    def: ComponentDef<S>,
    value: Partial<ValueOf<S>>
  ): boolean {
    if (this.guard !== undefined && this.guard.writes[def.id] !== true) {
      this.refuse(`wrote "${def.name}" through the world`, "write");
    }
    if (!this.has(entity, def)) {
      return false;
    }
    if (def.relation !== undefined && "target" in value) {
      throw new Error(retarget(def.name));
    }
    if (this._frozen) {
      throw new Error(frozenWrite("World.set()"));
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
    if (this._recording) {
      this.saveRow(def, cols, row);
    }
    for (const key in value) {
      const given = value[key];
      // A number named and not given is left as it was: `set` writes the
      // fields it is handed, and an undefined would be NaN among floats.
      if (given !== undefined || isBoxed(def.schema[key]!.kind)) {
        cols[key]![row] = given;
      }
    }
    this._changed[def.id]?.note(index);
    return true;
  }

  // --- relations -------------------------------------------------------------

  /**
   * Returns the entities that point at `target` with a relation, in order of
   * index: a parent's children, or whatever is aiming at something. Finding
   * them doesn't examine any other entity.
   */
  sources(target: Entity, def: ComponentDef): Entity[] {
    if (this.guard !== undefined && this.guard.reads[def.id] !== true) {
      this.refuse(`read "${def.name}" through the world`, "read");
    }
    const relation = this.relations[def.id];
    if (relation === undefined || !this.isAlive(target)) {
      return [];
    }
    return relation
      .sources(entityIndex(target))
      .map((source) => makeEntity(source, this.gens[source]!));
  }

  /** Returns a relation's index of which entities point at which, creating it if needed. */
  private relationOf(def: ComponentDef): RelationIndex {
    let relation = this.relations[def.id];
    if (relation === undefined) {
      relation = new RelationIndex(def, this.recTable.length);
      this.relations[def.id] = relation;
      this.relationList = [...this.relationList, relation].toSorted((a, b) =>
        byName(a.def, b.def)
      );
    }
    return relation;
  }

  /**
   * Rebuilds which entities point at which from a loaded snapshot. A relation
   * pointing at a missing entity is one no world could have saved.
   */
  private indexRelations(): void {
    for (const def of this.componentsByName.values()) {
      if (def.relation === undefined) {
        continue;
      }
      const link = (
        entities: Uint32Array | Float64Array,
        targets: Float64Array,
        count: number
      ): void => {
        for (let row = 0; row < count; row++) {
          const target = targets[row] as Entity;
          if (!this.isAlive(target)) {
            throw corrupt(
              `"${def.name}" points at an entity that does not exist`
            );
          }
          this.relationOf(def).link(
            entities[row]! & INDEX_MASK,
            entityIndex(target)
          );
        }
      };
      if (def.storage === "sparse") {
        const set = this.sparseById.get(def.id);
        if (set !== undefined) {
          link(set.dense, set.columns.target as Float64Array, set.count);
        }
        continue;
      }
      for (const table of this.tables) {
        const columns = table.columns[def.id];
        if (columns !== undefined) {
          link(table.entities, columns.target as Float64Array, table.count);
        }
      }
    }
  }

  // --- singletons ------------------------------------------------------------

  /**
   * Returns the world's single instance of a singleton, as an object whose
   * fields you read and write in place:
   *
   *   const turn = world.singleton(Turn)
   *   turn.player = turn.player === 1 ? 2 : 1
   *
   * It holds the singleton's initial value until it is written. From then on it
   * is part of the world: in its snapshot and its hash, and restored by a
   * rollback. Reading it changes nothing, so a world that has only read a
   * singleton hashes the same as one that never accessed it.
   */
  singleton<S extends Schema>(spec: SingletonSpec<S>): ValueOf<S> {
    if (
      this.guard !== undefined &&
      this.guard.reads[spec.component.id] !== true
    ) {
      this.refuse(`asked for the singleton "${spec.component.name}"`, "read");
    }
    const found = this.singles[spec.component.id];
    if (found !== undefined) {
      if (found.initial === undefined) {
        // Made by a load, which knew its fields and not its initial value.
        found.initial = spec.initial;
        if (!found.written) {
          writeRow(spec.component, found.columns, 0, spec.initial);
        }
      }
      return found.value as ValueOf<S>;
    }
    if (!spec.component.single) {
      throw new Error(
        `"${spec.component.name}" is a component, not a singleton. Define a singleton with Component.singleton.`
      );
    }
    const single = this.single(spec.component);
    single.initial = spec.initial;
    writeRow(spec.component, single.columns, 0, spec.initial);
    return single.value as ValueOf<S>;
  }

  /** Returns a singleton's instance, creating it if needed with every field zero. */
  private single(def: ComponentDef): Single {
    let single = this.singles[def.id];
    if (single === undefined) {
      this.register(def);
      const columns = makeColumns(def, 1);
      const value = {};
      single = { def, columns, initial: undefined, written: false, value };
      const made = single;
      for (const field of def.fields) {
        const column = columns[field]!;
        Object.defineProperty(value, field, {
          enumerable: true,
          get: () => column[0],
          set: (to: unknown) => {
            this.writing(made);
            column[0] = to;
          },
        });
      }
      this.singles[def.id] = single;
      this.singlesByName = undefined;
    }
    return single;
  }

  /** Called before a singleton is written, so a rollback can restore it. */
  private writing(single: Single): void {
    if (this._frozen) {
      throw new Error(
        frozenWrite(`A write to the singleton "${single.def.name}"`)
      );
    }
    if (this.guard !== undefined && this.guard.writes[single.def.id] !== true) {
      this.refuse(`wrote the singleton "${single.def.name}"`, "write");
    }
    if (this._recording && !this.savedWhole.has(single.columns)) {
      this.savedSingles.push({ single, written: single.written });
      this._saveColumns(single.def, single.columns, 1);
    }
    single.written = true;
  }

  /** Returns the singletons that have been written, in order of name. */
  private writtenSingles(): Single[] {
    this.singlesByName ??= this.singles
      .filter((single) => single !== undefined)
      .toSorted((a, b) => byName(a.def, b.def));
    return this.singlesByName.filter((single) => single.written);
  }

  // --- freezing ---------------------------------------------------------------

  /**
   * Freezes the world: until `thaw`, it can be read but not changed. Anything
   * that would change it throws and explains why: `spawn`, `despawn`, `add`,
   * `remove`, `set`, a write to a singleton, a command queued on a
   * `CommandBuffer`, and an assignment through the accessors of `each`.
   *
   * An app freezes its world for the frame stage, which draws the game between
   * two ticks and must leave it unchanged.
   *
   * Two things aren't stopped at the point they happen, because stopping them
   * there would slow every loop and every draw. A draw from `world.random` is
   * detected by `thaw`, which restores the generator and throws. A write
   * through the raw columns `eachChunk` hands out isn't detected at all:
   * compare `world.hash()` before and after to find it.
   *
   * In a frozen world, `eachChunk` counts nothing as written, so a change query
   * can hand out a component it watches.
   */
  freeze(): void {
    if (this._recording) {
      throw new Error(
        "World.freeze() was called inside a transaction. Commit or roll back first."
      );
    }
    this.frozenRandom.set(this.random.state);
    this._frozen = true;
  }

  /**
   * Ends a freeze. If random numbers were drawn from the world's generator in
   * the meantime, it restores the generator, so the world is as it was, and
   * throws: the draw was a change, and a bug.
   */
  thaw(): void {
    if (!this._frozen) {
      return;
    }
    this._frozen = false;
    const { state } = this.random;
    const was = this.frozenRandom;
    if (
      state[0] !== was[0] ||
      state[1] !== was[1] ||
      state[2] !== was[2] ||
      state[3] !== was[3]
    ) {
      state.set(was);
      throw new Error(
        `${frozenWrite("A draw from world.random")} What draws the game takes its random numbers from the frame stage's own Random, which is not part of the world.`
      );
    }
  }

  /** Whether the world is frozen. */
  get frozen(): boolean {
    return this._frozen;
  }

  // --- the guard ---------------------------------------------------------------

  /** Throws a guard refusal that names who, what, and how to fix it. */
  private refuse(did: string, how: "read" | "write"): never {
    const { advice, who } = this.guard!;
    throw new Error(
      `${who} ${did}, and did not say it would ${how} it.${advice}`
    );
  }

  /**
   * Checks a query against the guard: its terms count as written, except the
   * read-only ones, and what it requires, excludes or watches counts as read. A
   * query that passes is remembered and not checked again.
   */
  private guardQuery(guard: Guard, spec: QuerySpec): void {
    for (const def of spec.terms as readonly ComponentDef[]) {
      if (spec.readDefs?.includes(def) === true) {
        if (guard.reads[def.id] !== true) {
          this.refuse(`asked for a query that reads "${def.name}"`, "read");
        }
      } else if (guard.writes[def.id] !== true) {
        this.refuse(`asked for a query that writes "${def.name}"`, "write");
      }
    }
    for (const defs of [
      spec.withDefs,
      spec.withoutDefs,
      spec.changedDefs ?? [],
      spec.addedDefs ?? [],
    ]) {
      for (const def of defs) {
        if (guard.reads[def.id] !== true) {
          this.refuse(`asked for a query that reads "${def.name}"`, "read");
        }
      }
    }
    guard.queries.add(spec);
  }

  /**
   * Holds a spawn, an add or a remove to the guard: every component it
   * names has to be one that may be written.
   * @internal
   */
  _guardWrites(
    inputs: readonly ComponentInput[],
    did: "spawned an entity with" | "added" | "removed"
  ): void {
    const { writes } = this.guard!;
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!;
      const def = isComponentDef(input) ? input : input.def;
      if (writes[def.id] !== true) {
        this.refuse(`${did} "${def.name}"`, "write");
      }
    }
  }

  /**
   * Holds a despawn to the guard. A despawn takes everything an entity
   * has, whatever was said, so it is held to this much: the entity has a
   * component that may be written, which is how whoever despawns it knows
   * it. One that is gone, or not placed yet, loses nothing.
   * @internal
   */
  _guardDespawn(entity: Entity): void {
    const { advice, who, writeDefs } = this.guard!;
    if (
      !this.isAlive(entity) ||
      this.recTable[entityIndex(entity)] === NOT_PLACED
    ) {
      return;
    }
    for (let i = 0; i < writeDefs.length; i++) {
      if (this.has(entity, writeDefs[i]!)) {
        return;
      }
    }
    throw new Error(
      `${who} despawned an entity that has none of the components it said it writes (${writeDefs.map((def) => `"${def.name}"`).join(", ") || "none"}). A despawn takes everything an entity has, and is said by a component the entity is known by: one of those it has.${advice}`
    );
  }

  // --- transactions ----------------------------------------------------------

  /**
   * Starts a transaction. Until `commit` or `rollback`:
   *
   * - every write to component data through `set`, `each` and `eachChunk` can
   *   be rolled back by `rollback`, as can every random number drawn;
   * - `spawn`, `despawn`, `add` and `remove` throw. Queue them on a
   *   `CommandBuffer`, whose own `rollback` discards them. Rows therefore stay
   *   in place for the duration of the transaction, which is what makes rolling
   *   back a write a plain copy.
   *
   * An action's handler runs inside one, so a refused action leaves nothing
   * behind. What is saved is what is about to be written: one row for `set`,
   * and for a loop, the columns of the query's terms in each table it visits,
   * once each.
   *
   * An object held in a `ref` field and mutated in place isn't restored: the
   * field still holds the same object.
   */
  begin(): void {
    if (this._frozen) {
      throw new Error(frozenWrite("World.begin()"));
    }
    if (this._recording) {
      throw new Error(
        "World.begin() was called inside a transaction. Commit or roll back the one in progress first."
      );
    }
    // Four assignments, not `set`: this runs for every action.
    const from = this.random.state;
    const to = this.savedRandom;
    to[0] = from[0]!;
    to[1] = from[1]!;
    to[2] = from[2]!;
    to[3] = from[3]!;
    // What is noted from here on is forgotten again by a rollback.
    const { writeLogs } = this;
    for (let i = 0; i < writeLogs.length; i++) {
      writeLogs[i]!.txEnd = writeLogs[i]!.end;
    }
    this._recording = true;
  }

  /** Ends the transaction and keeps what was written. */
  commit(): void {
    this.endTransaction("commit");
  }

  /** Ends the transaction and restores everything written since `begin`. */
  rollback(): void {
    const { saved } = this;
    // Newest first, so that where a row was saved before its whole column,
    // the oldest value is the one left standing.
    for (let i = saved.length - 1; i >= 0; i--) {
      const { cols, copies, count, def, row } = saved[i]!;
      for (let f = 0; f < def.fields.length; f++) {
        const column = cols[def.fields[f]!]!;
        if (row !== WHOLE) {
          column[row] = copies[f];
        } else if (isBoxed(def.kinds[f]!)) {
          const from = copies[f] as unknown[];
          for (let r = 0; r < count; r++) {
            column[r] = from[r];
          }
        } else {
          (column as Float32Array).set(
            (copies[f] as Float32Array).subarray(0, count)
          );
        }
      }
    }
    this.random.state.set(this.savedRandom);
    const { savedSingles } = this;
    for (let i = savedSingles.length - 1; i >= 0; i--) {
      savedSingles[i]!.single.written = savedSingles[i]!.written;
    }
    // The changes it noted, and the visits its change queries made.
    const { movedReaders, writeLogs } = this;
    for (let i = movedReaders.length - 1; i >= 0; i--) {
      const { at, cursor, fresh } = movedReaders[i]!;
      cursor.at = at;
      cursor.fresh = fresh;
    }
    for (let i = 0; i < writeLogs.length; i++) {
      // A log started inside the transaction has noted nothing before it.
      const log = writeLogs[i]!;
      log.txEnd = Math.min(log.txEnd, log.end);
      log.rollback();
    }
    this.endTransaction("rollback");
  }

  private endTransaction(op: string): void {
    if (!this._recording) {
      throw new Error(
        `World.${op}() was called with no transaction in progress. Call begin() first.`
      );
    }
    this.saved.length = 0;
    this.savedSingles.length = 0;
    if (this.savedWhole.size > 0) {
      this.savedWhole.clear();
    }
    this._recording = false;
    if (this.movedReaders.length > 0) {
      // Readers stay where they are for as long as a rollback could put
      // them back; now the logs can forget what all of them have visited.
      this.movedReaders.length = 0;
      for (const log of this.logs) {
        log.moved();
      }
    }
  }

  /**
   * Saves rows `[0, count)` of a component's columns, unless this
   * transaction already has.
   * @internal
   */
  _saveColumns(def: ComponentDef, cols: Columns, count: number): void {
    if (def.isTag || this.savedWhole.has(cols)) {
      return;
    }
    this.savedWhole.add(cols);
    let copies = this.spare.get(cols);
    if (copies === undefined) {
      copies = [];
      this.spare.set(cols, copies);
    }
    for (let f = 0; f < def.fields.length; f++) {
      const column = cols[def.fields[f]!]!;
      const kept = copies[f] as Column | undefined;
      if (kept === undefined || kept.length < count) {
        // Room for the column as it is now; a column only grows by doubling.
        copies[f] = column.slice(0, column.length);
      } else if (isBoxed(def.kinds[f]!)) {
        const to = kept as unknown[];
        for (let r = 0; r < count; r++) {
          to[r] = column[r];
        }
      } else {
        (kept as Float32Array).set((column as Float32Array).subarray(0, count));
      }
    }
    this.saved.push({ cols, copies, count, def, row: WHOLE });
  }

  /** Saves one row of a component's columns. */
  private saveRow(def: ComponentDef, cols: Columns, row: number): void {
    if (this.savedWhole.has(cols)) {
      return;
    }
    const copies: unknown[] = [];
    for (let f = 0; f < def.fields.length; f++) {
      copies.push(cols[def.fields[f]!]![row]);
    }
    this.saved.push({ cols, copies, count: 1, def, row });
  }

  /**
   * Registers a component with the world. A component is registered
   * automatically the first time the world stores or queries it, so this is
   * only needed to look one up by name before then. Its name is its identity in
   * this world: a second component with the same name is refused.
   */
  register(def: ComponentDef): void {
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
    this.shapes[def.id] = shapeOf(def.name, def.fields, def.kinds);
    this.registered[def.id] = true;
  }

  /** @internal Registers the component of every input. */
  _registerAll(inputs: readonly ComponentInput[]): void {
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!;
      const def = isComponentDef(input) ? input : input.def;
      if (def.single) {
        this.refuseSingle(def);
      }
      if (def.relation !== undefined && isComponentDef(input)) {
        throw targetless(def);
      }
      this.register(def);
    }
  }

  /** Returns the registered component with this name, for saves, the network and tools. */
  component(name: string): ComponentDef | undefined {
    return this.componentsByName.get(name);
  }

  // --- queries -------------------------------------------------------------

  /**
   * Resolves a query description against this world. Cached per description.
   *
   * A description with `changedDefs` or `addedDefs` is a change query. Its view
   * visits only the entities that had one of those components written, or
   * gained one, since the view last visited, in the usual query order; the
   * first time, that is every matching entity. `each`, `eachChunk` and
   * `entities` count as visits, and `count` doesn't. When nothing changed, a
   * visit costs a few comparisons.
   *
   * Such a view belongs to one reader: `reader`, or `world.reader`, or an
   * anonymous one. Two readers of the same description each see every change
   * once. A reader is identified by its name and the description's components,
   * so two equivalent descriptions share a view.
   *
   * A write is recorded per row by `set`, by `add` with a value, and by the
   * setters of `each`. `eachChunk` hands out raw columns and can't detect
   * writes, so every row it hands out counts as written, except for the terms
   * the description declares read-only (`readDefs`). Only watched components
   * are recorded at all.
   */
  view<D extends Terms>(spec: QuerySpec<D>, reader?: string): QueryView<D> {
    if (this.guard !== undefined && !this.guard.queries.has(spec)) {
      this.guardQuery(this.guard, spec);
    }
    // The views are kept by their description, so each is a view of `D`.
    let view = this.views.get(spec);
    if (view !== undefined) {
      return view as QueryView<D>;
    }
    const watching =
      (spec.changedDefs?.length ?? 0) + (spec.addedDefs?.length ?? 0) > 0;
    const who = reader ?? this.reader ?? "";
    let byReader: Map<string, QueryView> | undefined;
    if (watching) {
      byReader = this.watchViews.get(spec);
      if (byReader === undefined) {
        byReader = new Map();
        this.watchViews.set(spec, byReader);
      }
      view = byReader.get(who);
      if (view !== undefined) {
        return view as QueryView<D>;
      }
    }
    for (const defs of [
      spec.terms,
      spec.withDefs,
      spec.withoutDefs,
      spec.changedDefs ?? [],
      spec.addedDefs ?? [],
    ]) {
      for (const def of defs) {
        this.register(def);
      }
    }
    if (byReader === undefined) {
      view = new QueryView(this, spec);
      this.views.set(spec, view);
      return view as QueryView<D>;
    }
    const key = `${who}\n${describeSpec(spec)}`;
    view = this.watchViewsByKey.get(key);
    if (view === undefined) {
      view = new QueryView(this, spec, key);
      this.watchViewsByKey.set(key, view);
    }
    byReader.set(who, view);
    return view as QueryView<D>;
  }

  // --- changes ---------------------------------------------------------------

  /**
   * Returns the entities that lost a component, by `remove` or by being
   * despawned, since this reader last read. Removals are tracked from the first
   * time anyone requests them. There is one reader per name and component:
   * `reader`, or `world.reader`, or an anonymous one.
   */
  removed(def: ComponentDef, reader?: string): RemovedReader {
    if (this.guard !== undefined && this.guard.reads[def.id] !== true) {
      this.refuse(`asked which entities lost "${def.name}"`, "read");
    }
    const who = reader ?? this.reader ?? "";
    const key = `${def.id}\n${who}`;
    let found = this.removedReaders.get(key);
    if (found === undefined) {
      this.register(def);
      const log = this._log(def, "removed");
      found = new RemovedReader(this, log, log.cursor(who, false));
      this.removedReaders.set(key, found);
    }
    return found;
  }

  /** @internal The log of one kind of change to a component, started if need be. */
  _log(def: ComponentDef, kind: ChangeKind): ChangeLog {
    const byId =
      kind === "changed"
        ? this._changed
        : kind === "added"
          ? this.addedLogs
          : this.removedLogs;
    let log = byId[def.id];
    if (log === undefined) {
      log = new ChangeLog(def, kind, this);
      byId[def.id] = log;
      this.logs.push(log);
      if (kind === "changed") {
        this.writeLogs.push(log);
        this._watched++;
        if (this._iterating > 0) {
          this.lateLogs.push(log);
        }
      }
    }
    return log;
  }

  /** @internal A reader is about to move. A rollback puts it back. */
  _reading(cursor: ChangeCursor): void {
    if (this._recording) {
      this.movedReaders.push({ cursor, at: cursor.at, fresh: cursor.fresh });
    }
  }

  /** @internal A reader has visited a log up to its end. */
  _read(log: ChangeLog): void {
    log.visited();
  }

  /** @internal A query's iteration has ended. */
  _left(): void {
    if (--this._iterating === 0 && this.lateLogs.length > 0) {
      // A log that was started while a loop was running missed what that
      // loop went on to write: its accessors were made before there was a
      // log to note in. So its readers start over, from everything.
      for (const log of this.lateLogs) {
        for (const cursor of log.cursors) {
          cursor.fresh = true;
        }
      }
      this.lateLogs = [];
    }
  }

  /**
   * Returns what change queries and `removed` readers have yet to visit, as
   * plain data: one entry per component and kind of change, in order of name. A
   * snapshot doesn't hold this, since it belongs to the world's readers rather
   * than the world itself; a game's save does. `keep` selects which readers to
   * save, by name, and defaults to all of them.
   */
  saveChanges(keep?: (reader: string) => boolean): SavedChanges[] {
    const out: SavedChanges[] = [];
    for (const log of this.logs) {
      const saved = log.save((key) =>
        keep === undefined ? true : keep(key.split("\n", 1)[0]!)
      );
      if (saved !== undefined) {
        out.push(saved);
      }
    }
    return out.toSorted(
      (a, b) =>
        byName({ name: a.component }, { name: b.component }) ||
        byName({ name: a.kind }, { name: b.kind })
    );
  }

  /**
   * Restores what `saveChanges` returned, in a world that has just loaded the
   * snapshot taken with it and hasn't watched anything yet. A reader that
   * requests its changes afterwards continues from where it was; one the save
   * doesn't know starts by visiting everything. Changes to components this
   * world doesn't know are dropped.
   */
  restoreChanges(saved: readonly SavedChanges[]): void {
    if (this.logs.length > 0) {
      throw new Error(
        "World.restoreChanges() was called in a world whose changes are already being watched. Call it right after load(), before any query runs."
      );
    }
    for (const changes of saved) {
      const def = this.componentsByName.get(changes.component);
      if (def !== undefined) {
        this._log(def, changes.kind).restore(changes);
      }
    }
  }

  // --- snapshots -----------------------------------------------------------

  /**
   * Serializes the whole world to bytes: every table and sparse set, every
   * singleton that has been written, the upcoming ids, and the random
   * generator's state. A world that loads the bytes hashes the same as this one
   * and behaves the same from then on: the same iteration order, the same ids
   * for new entities, the same random numbers.
   *
   * A component is written under its name, with its field names and types, so
   * the bytes don't depend on the order a program defines its components in.
   * Numeric columns are written raw, which makes a snapshot about as big as the
   * data: four bytes for an `f32`, and so on.
   *
   * A `json` field is written as the plain data it holds, a `ref` field as its
   * codec's encoding of each value, and a `transient` field not at all. A value
   * that isn't plain data, or that a codec won't encode, has no serialized
   * form, and the snapshot is refused with a `SnapshotError` naming the field.
   * So is a world with a spawn queued on a `CommandBuffer` but not yet applied.
   */
  snapshot(): Uint8Array {
    const { tables } = this;
    let placed = 0;
    let estimate = 256 + this.nextIndex * 4 + this.freeList.length * 4;
    for (const table of tables) {
      placed += table.count;
      estimate += 64 + table.count * 8;
      for (const def of table.defs) {
        for (const kind of def.kinds) {
          estimate += table.count * (isBoxed(kind) ? 8 : WIDTH[kind as "f32"]);
        }
      }
    }
    if (placed !== this.alive) {
      throw new SnapshotError(
        "cannot be saved",
        `${this.alive - placed} entities were spawned through a CommandBuffer that has not been applied yet. Apply it, or roll it back, and take the snapshot then.`
      );
    }
    const sets = this.sparseSetsByName().filter((set) => set.count > 0);
    const singles = this.writtenSingles();

    // The components that hold anything, or have a table, in order of name.
    const used = new Map<ComponentDef, number>();
    for (const table of tables) {
      for (const def of table.defs) {
        used.set(def, 0);
      }
    }
    for (const set of sets) {
      used.set(set.def, 0);
    }
    for (const single of singles) {
      used.set(single.def, 0);
    }
    const components = Array.from(used.keys()).toSorted(byName);
    for (let i = 0; i < components.length; i++) {
      used.set(components[i]!, i);
    }

    const writer = new Writer(estimate);
    writer.u32(MAGIC);
    writer.u32(FORMAT);
    const random = this.random.state;
    for (let word = 0; word < 4; word++) {
      writer.u32(random[word]!);
    }

    // Every slot's generation, and the freed slots in the order they will be
    // handed out again.
    writer.u32(this.nextIndex);
    writer.numbers(this.gens, this.nextIndex, 4);
    writer.u32(this.freeList.length);
    for (const index of this.freeList) {
      writer.u32(index);
    }

    writer.u32(components.length);
    for (const def of components) {
      writer.text(def.name);
      writer.u8(storageOf(def));
      writer.u32(def.fields.length);
      for (let f = 0; f < def.fields.length; f++) {
        writer.text(def.fields[f]!);
        writer.u8(KIND_CODES.indexOf(def.kinds[f]!));
      }
    }

    const writeFields = (
      def: ComponentDef,
      columns: Columns,
      count: number
    ): void => {
      for (let f = 0; f < def.fields.length; f++) {
        const field = def.fields[f]!;
        const row = writeColumn(
          writer,
          def.kinds[f]!,
          columns[field]!,
          count,
          def.codecs[f]
        );
        if (row !== -1) {
          throw new SnapshotError(
            "cannot be saved",
            def.kinds[f] === "ref"
              ? `"${def.name}.${field}" holds a value its codec did not turn into plain data (${describeValue(columns[field]![row])}).`
              : `"${def.name}.${field}" holds a value that is not plain data (${describeValue(columns[field]![row])}). A json field holds text, numbers, booleans, bigints, null and undefined, and arrays and objects of text, numbers, booleans and null. Give the field a codec with Field.ref, or make it Field.transient if it is not to be saved.`,
            def.name
          );
        }
      }
    };

    // Tables in creation order, the empty ones too: where a table stands
    // decides where its entities are visited.
    writer.u32(tables.length);
    for (const table of tables) {
      const { count, defsByName } = table;
      writer.u32(defsByName.length);
      for (const def of defsByName) {
        writer.u32(used.get(def)!);
      }
      writer.u32(count);
      writer.numbers(table.entities, count, 8);
      for (const def of defsByName) {
        writeFields(def, table.columns[def.id]!, count);
      }
    }

    writer.u32(sets.length);
    for (const set of sets) {
      writer.u32(used.get(set.def)!);
      writer.u32(set.count);
      writer.numbers(set.dense, set.count, 4);
      writeFields(set.def, set.columns, set.count);
    }
    // The singletons that have been written, each one row.
    writer.u32(singles.length);
    for (const single of singles) {
      writer.u32(used.get(single.def)!);
      writeFields(single.def, single.columns, 1);
    }
    writer.u32(END);
    return writer.finish();
  }

  /**
   * Replaces everything in this world with a snapshot: the world is emptied and
   * then loaded, as `load` loads a new one. It is meant for a snapshot this
   * world took itself, or one from an identically built world, since it only
   * knows the components it has encountered.
   *
   * Afterwards, the world holds what a new world that loaded the snapshot
   * would: the same hash, the same iteration order, the same upcoming ids, the
   * same random numbers. A singleton's value stays the same object, holding the
   * snapshot's value, or its initial value if the snapshot doesn't hold it.
   * `world.random` stays the same generator.
   *
   * Anything derived from the old tables doesn't survive it. A view or a
   * `removed` reader obtained before throws when used: obtain it again, as a
   * system does every tick. What change queries hadn't visited is dropped, as
   * in a new world: `restoreChanges` restores what `saveChanges` returned when
   * the snapshot was taken.
   *
   * Not allowed while a query is iterating, in a transaction, or while the
   * world is frozen. Every failure is a `SnapshotError`, as for `load`, and a
   * world whose restore failed partway is unusable.
   */
  restore(bytes: Uint8Array): void {
    if (this._recording) {
      throw new Error(
        "World.restore() was called between begin() and commit() or rollback(). A transaction puts back what it wrote itself; restore a snapshot outside one."
      );
    }
    // Not in a frozen world either, nor in the middle of a loop.
    this.assertNotIterating("restore");
    let placed = 0;
    for (const table of this.tables) {
      placed += table.count;
    }
    if (placed !== this.alive) {
      throw new Error(
        `World.restore() was called while ${this.alive - placed} entities were spawned through a CommandBuffer that has not been applied. Their ids would outlive the world they were given in: apply the buffer, or roll it back, first.`
      );
    }
    // The entities.
    this.recTable.fill(FREE);
    this.recRow.fill(0);
    this.gens.fill(0);
    this.freeList.length = 0;
    this.nextIndex = 0;
    this.alive = 0;
    // Where their data is.
    this.tables.length = 0;
    this.tableByKey.clear();
    this.sparseById.clear();
    this.sparseList.length = 0;
    this.sparseByName = undefined;
    this.relations.length = 0;
    this.relationList = [];
    // What was made of those: views, and what they had yet to visit.
    this._restored++;
    this.views.clear();
    this.watchViews.clear();
    this.watchViewsByKey.clear();
    this.removedReaders.clear();
    this._changed.length = 0;
    this.addedLogs.length = 0;
    this.removedLogs.length = 0;
    this.logs.length = 0;
    this.writeLogs.length = 0;
    this._watched = 0;
    this.lateLogs = [];
    // The singletons stay the objects they are, as if never written.
    for (const single of this.singles) {
      if (single !== undefined) {
        single.written = false;
        writeRow(single.def, single.columns, 0, single.initial);
      }
    }
    this.load(bytes);
  }

  /**
   * Fills this world from a snapshot. The world must be empty: one that has
   * never held an entity.
   *
   * `components` are the components the snapshot may contain. A world
   * identifies components by name, and an empty world knows none, so pass them
   * here (already registered ones can be omitted). A snapshot that contains a
   * component not among them, or one whose fields differ from when it was
   * taken, is refused.
   *
   * Every failure is a `SnapshotError`, whose `problem` identifies the kind:
   * the bytes aren't a snapshot, are truncated or corrupt, or use a newer
   * format; a component is unknown or has changed; or the world isn't empty.
   * Counts are checked against the available bytes before anything is allocated
   * for them. A world whose load failed partway is unusable: load into a new
   * one.
   */
  load(bytes: Uint8Array, components: readonly ComponentDef[] = []): void {
    if (
      this.nextIndex !== 0 ||
      this.tables.length > 0 ||
      this._recording ||
      this.singles.some((single) => single?.written === true)
    ) {
      throw new SnapshotError(
        "world not empty",
        "World.load() fills an empty world, and this one has held entities or has written a singleton. Load into a new World."
      );
    }
    for (const def of components) {
      this.register(def);
    }
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
    const random = this.random.state;
    for (let word = 0; word < 4; word++) {
      random[word] = reader.u32();
    }

    // Format 3 widened an entity's id: a generation is four bytes where it
    // was two, and an id, in a table or in a field, eight where it was four.
    // An id of the older formats is the same number, in a narrower place.
    const narrow = format < 3;
    const nextIndex = reader.count(narrow ? 2 : 4);
    if (nextIndex > INDEX_MASK + 1) {
      throw corrupt("it holds more entity slots than a world can have");
    }
    while (this.recTable.length < nextIndex) {
      this.growRecords();
    }
    if (narrow) {
      const generations = new Uint16Array(nextIndex);
      reader.numbers(generations, nextIndex, 2);
      this.gens.set(generations);
    } else {
      reader.numbers(this.gens, nextIndex, 4);
    }
    // A slot whose generations are used up is neither free nor anyone's.
    let retired = 0;
    for (let index = 0; index < nextIndex; index++) {
      if (this.gens[index]! > GENERATIONS) {
        throw corrupt("a slot has a generation no entity could have");
      }
      if (this.gens[index] === GENERATIONS) {
        retired++;
      }
    }
    const freed = reader.count(4);
    // Every slot is taken to be free until a table claims it.
    const isFree = new Uint8Array(nextIndex);
    for (let i = 0; i < freed; i++) {
      const index = reader.u32();
      if (
        index >= nextIndex ||
        isFree[index] === 1 ||
        this.gens[index] === GENERATIONS
      ) {
        throw corrupt(
          "its list of freed slots names a slot twice, one that does not exist, or one that is used up"
        );
      }
      isFree[index] = 1;
      this.freeList.push(index);
    }
    this.nextIndex = nextIndex;

    // The components, checked against the ones this program defines.
    const named: ComponentDef[] = [];
    const componentCount = reader.count(9);
    for (let c = 0; c < componentCount; c++) {
      const name = reader.text();
      const storage = reader.u8();
      const fields: string[] = [];
      const kinds: (string | undefined)[] = [];
      const fieldCount = reader.count(5);
      for (let f = 0; f < fieldCount; f++) {
        fields.push(reader.text());
        kinds.push(KIND_CODES[reader.u8()]);
      }
      const def = this.componentsByName.get(name);
      if (def === undefined) {
        throw new SnapshotError(
          "unknown component",
          `The snapshot holds a component named "${name}", which is not among the components it was loaded with.`,
          name
        );
      }
      const was = fields.map((field, f) => `${field}: ${kinds[f]}`).join(", ");
      const is = def.fields
        .map((field, f) => `${field}: ${def.kinds[f]}`)
        .join(", ");
      if (was !== is || storage !== storageOf(def)) {
        throw new SnapshotError(
          "component changed",
          `"${name}" is not what it was when the snapshot was taken. Then: ${STORAGES[storage] ?? "unknown"} { ${was} }. Now: ${STORAGES[storageOf(def)]} { ${is} }.`,
          name
        );
      }
      named.push(def);
    }
    const componentAt = (): ComponentDef => {
      const def = named[reader.u32()];
      if (def === undefined) {
        throw corrupt("it refers to a component it does not list");
      }
      return def;
    };

    const tableCount = reader.count(8);
    for (let t = 0; t < tableCount; t++) {
      const defs: ComponentDef[] = [];
      const defCount = reader.count(4);
      for (let d = 0; d < defCount; d++) {
        const def = componentAt();
        if (def.storage !== "table" || def.single || defs.includes(def)) {
          throw corrupt(
            "a table lists a component twice, or one that no table holds"
          );
        }
        defs.push(def);
      }
      const sorted = defs.toSorted((a, b) => a.id - b.id);
      const key = sorted.map((def) => def.id).join(",");
      if (this.tableByKey.has(key)) {
        throw corrupt("it holds two tables for the same components");
      }
      const count = reader.count(narrow ? 4 : 8);
      let capacity = 16;
      while (capacity < count) {
        capacity *= 2;
      }
      const table = new Table(this.tables.length, sorted, capacity);
      this.tables.push(table);
      this.tableByKey.set(key, table);
      if (narrow) {
        const ids = new Uint32Array(count);
        reader.numbers(ids, count, 4);
        table.entities.set(ids);
      } else {
        reader.numbers(table.entities, count, 8);
      }
      table.count = count;
      for (let row = 0; row < count; row++) {
        const entity = table.entities[row] as Entity;
        const index = entityIndex(entity);
        // Eight bytes can hold what is no id at all: a number that is not
        // whole, below nothing, or past the last id. None of those is its
        // index and a generation a slot could have; and a slot whose
        // generations are used up, which the count below takes for
        // nobody's, is one too many if it holds an entity.
        if (
          index >= nextIndex ||
          isFree[index] === 1 ||
          this.recTable[index] !== FREE ||
          this.gens[index] !== (entity - index) / SLOTS
        ) {
          throw corrupt(
            "an entity is in two places, or in a slot that is free or of another generation"
          );
        }
        this.recTable[index] = table.index;
        this.recRow[index] = row;
      }
      this.alive += count;
      // The same order the fields were written in: components by name.
      for (const def of defs) {
        for (let f = 0; f < def.fields.length; f++) {
          this.readField(reader, def, f, table.columns[def.id]!, count, narrow);
        }
      }
    }
    if (this.alive + freed + retired !== nextIndex) {
      throw corrupt("some entity slots are neither in a table nor free");
    }

    const setCount = reader.count(8);
    for (let s = 0; s < setCount; s++) {
      const def = componentAt();
      if (def.storage !== "sparse" || def.single) {
        throw corrupt("a sparse set is of a component that is not sparse");
      }
      const set = this._sparse(def);
      const count = reader.count(4);
      if (set.count > 0) {
        throw corrupt("it holds two sparse sets for one component");
      }
      for (let i = 0; i < count; i++) {
        const index = reader.u32();
        if (index >= nextIndex || this.recTable[index]! < 0 || set.has(index)) {
          throw corrupt(
            "a sparse component is on an entity that does not exist, or on one twice"
          );
        }
        set.add(index, undefined);
      }
      for (let f = 0; f < def.fields.length; f++) {
        this.readField(reader, def, f, set.columns, count, narrow);
      }
    }
    // Format 1 had no singletons.
    const singleCount = format >= 2 ? reader.count(4) : 0;
    const loaded = new Set<Single>();
    for (let s = 0; s < singleCount; s++) {
      const def = componentAt();
      if (!def.single) {
        throw corrupt("a singleton is of a component that is not one");
      }
      const single = this.single(def);
      if (loaded.has(single)) {
        throw corrupt("it holds two values for one singleton");
      }
      loaded.add(single);
      for (let f = 0; f < def.fields.length; f++) {
        this.readField(reader, def, f, single.columns, 1, narrow);
      }
      single.written = true;
    }
    if (reader.left !== 4 || reader.u32() !== END) {
      throw corrupt("it does not end where it should");
    }
    this.indexRelations();
  }

  /** Reads one field's column, naming the field if its codec rejects a value. */
  private readField(
    reader: Reader,
    def: ComponentDef,
    f: number,
    columns: Columns,
    count: number,
    narrow: boolean
  ): void {
    const field = def.fields[f]!;
    try {
      readColumn(
        reader,
        def.kinds[f]!,
        columns[field]!,
        count,
        def.codecs[f],
        narrow
      );
    } catch (error) {
      if (error instanceof SnapshotError) {
        throw error;
      }
      throw new SnapshotError(
        "component changed",
        `"${def.name}.${field}" has a codec that refuses a value the snapshot holds: ${error instanceof Error ? error.message : String(error)}`,
        def.name
      );
    }
  }

  /** The sparse sets in order of component name. */
  private sparseSetsByName(): SparseSet[] {
    return (this.sparseByName ??= this.sparseList.toSorted((a, b) =>
      byName(a.def, b.def)
    ));
  }

  // --- hash ----------------------------------------------------------------

  /**
   * Returns a single number, from 0 to 2^32 - 1, for everything in the world a
   * simulation can observe:
   *
   * - every entity and the value of every field of every component it has, with
   *   components identified by name;
   * - the order queries visit entities in (tables in creation order, rows
   *   ascending);
   * - the ids the next entities will get;
   * - every singleton that has been written, by name;
   * - the state of the random number generator.
   *
   * Two worlds built by the same operations in the same order hash equal, on
   * any machine. Changing one field of one entity always changes the hash. Two
   * different worlds collide by chance about once in four billion.
   *
   * It doesn't depend on anything a simulation can't observe: a table's
   * capacity, leftover data past a column's last row, which queries were
   * created, the order a sparse component's members joined in, or the order
   * components were defined in. Every NaN counts as the same NaN, since its
   * bits are the one thing engines don't agree on; 0 and -0 differ. A `json`
   * field counts as the plain data it holds, a `ref` field as its codec's
   * encoding of each value, and a `transient` field not at all: the hash covers
   * exactly what a snapshot saves.
   *
   * Measured, it costs about 1.4 ns per 32-bit field per entity in a table,
   * with an entity's id counting as two: 0.8 ms for 100,000 entities with four
   * float fields, and about four times that per field of a sparse component.
   */
  hash(): number {
    const { shapes } = this;
    // The ids to come: the next unused index, then the freed slots in the
    // order they will be reused, each with the generation it will get.
    let h = add(add(0, this.nextIndex), this.alive);
    const { freeList, gens } = this;
    h = add(h, freeList.length);
    for (let i = 0; i < freeList.length; i++) {
      const index = freeList[i]!;
      h = add(add(h, index), gens[index]!);
    }

    // Tables, in the order queries visit them. An empty table is included:
    // where it stands decides where its future entities are visited.
    const { tables } = this;
    h = add(h, tables.length);
    for (let t = 0; t < tables.length; t++) {
      const table = tables[t]!;
      const { count, defsByName } = table;
      h = add(add(h, defsByName.length), count);
      // An entity's id carries its generation.
      h = addColumn(h, "entity", table.entities, count);
      for (let d = 0; d < defsByName.length; d++) {
        const def = defsByName[d]!;
        h = add(h, shapes[def.id]!);
        const columns = table.columns[def.id]!;
        for (let f = 0; f < def.fields.length; f++) {
          h = addColumn(
            h,
            def.kinds[f]!,
            columns[def.fields[f]!]!,
            count,
            def.codecs[f]
          );
        }
      }
    }

    // Sparse components, in order of name. The order of a set's members is
    // not something a query shows, so each member is hashed on its own and
    // the results are added up. A set nobody is in is as good as absent.
    const sets = this.sparseSetsByName();
    for (let s = 0; s < sets.length; s++) {
      const set = sets[s]!;
      const { count, def } = set;
      if (count === 0) {
        continue;
      }
      if (this.memberStates.length < count) {
        this.memberStates = new Int32Array(
          Math.max(count, this.memberStates.length * 2)
        );
      }
      const states = this.memberStates;
      const shape = shapes[def.id]!;
      const { dense } = set;
      for (let i = 0; i < count; i++) {
        states[i] = add(shape, dense[i]!);
      }
      for (let f = 0; f < def.fields.length; f++) {
        addColumnPerRow(
          states,
          def.kinds[f]!,
          set.columns[def.fields[f]!]!,
          count,
          def.codecs[f]
        );
      }
      let members = 0;
      for (let i = 0; i < count; i++) {
        members = (members + finish(states[i]!)) | 0;
      }
      h = add(add(add(h, shape), count), members);
    }

    // Singletons that have been written, in order of name. One that has
    // only been read holds its initial value, which no simulation can tell
    // from its not being there.
    if (this.singles.length > 0) {
      for (const { columns, def } of this.writtenSingles()) {
        h = add(add(h, SINGLETON), shapes[def.id]!);
        for (let f = 0; f < def.fields.length; f++) {
          h = addColumn(
            h,
            def.kinds[f]!,
            columns[def.fields[f]!]!,
            1,
            def.codecs[f]
          );
        }
      }
    }

    const random = this.random.state;
    h = add(add(add(add(h, random[0]!), random[1]!), random[2]!), random[3]!);
    return finish(h);
  }

  // --- internals -----------------------------------------------------------

  /** @internal */
  _sparse(def: ComponentDef): SparseSet {
    let set = this.sparseById.get(def.id);
    if (set === undefined) {
      this.refuseSingle(def);
      this.register(def);
      set = new SparseSet(def);
      this.sparseById.set(def.id, set);
      this.sparseList.push(set);
      this.sparseByName = undefined;
    }
    return set;
  }

  private tableFor(sortedDefs: readonly ComponentDef[]): Table {
    const key = sortedDefs.map((d) => d.id).join(",");
    let table = this.tableByKey.get(key);
    if (table === undefined) {
      for (const def of sortedDefs) {
        this.refuseSingle(def);
        this.register(def);
      }
      table = new Table(this.tables.length, sortedDefs);
      this.tables.push(table);
      this.tableByKey.set(key, table);
    }
    return table;
  }

  /** Refuses a singleton's fields where an entity component is expected. */
  private refuseSingle(def: ComponentDef): void {
    if (def.single) {
      throw new Error(
        `"${def.name}" is a singleton: the world holds one, and no entity has it. Read and write it with World.singleton().`
      );
    }
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
    if (this._frozen) {
      throw new Error(frozenWrite(`World.${op}()`));
    }
    if (this._recording) {
      throw new Error(
        `World.${op}() was called inside a transaction, where an action's handler runs. Queue it on Commands (a CommandBuffer): a refused action's commands are discarded, and its direct changes to which entities exist could not be.`
      );
    }
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
      /** Whether the id's index had never been used, which `rollback` needs to know. */
      readonly fresh: boolean;
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
      readonly def: ComponentDef;
    };

/**
 * Queues structural changes so they can be made from inside query loops, and
 * applied in one pass at a known point in the tick.
 *
 * @category Models
 */
export class CommandBuffer {
  private ops: Command[] = [];

  constructor(readonly world: World) {}

  get size(): number {
    return this.ops.length;
  }

  /** Returns the new entity's id immediately; it receives its components on apply. */
  spawn(...inputs: readonly ComponentInput[]): Entity {
    // Checked here, where the mistake is, and not when the queue is applied.
    this.world._registerAll(inputs);
    if (this.world.guard !== undefined) {
      this.world._guardWrites(inputs, "spawned an entity with");
    }
    const entity = this.world._reserve();
    this.ops.push({
      op: "spawn",
      entity,
      inputs,
      fresh: this.world._reservedFresh,
    });
    return entity;
  }

  despawn(entity: Entity): void {
    this.refuseFrozen("despawn");
    if (this.world.guard !== undefined) {
      this.world._guardDespawn(entity);
    }
    this.ops.push({ op: "despawn", entity });
  }

  add(entity: Entity, input: ComponentInput): void {
    this.refuseFrozen("add");
    this.world._registerAll([input]);
    if (this.world.guard !== undefined) {
      this.world._guardWrites([input], "added");
    }
    this.ops.push({ op: "add", entity, input });
  }

  remove(entity: Entity, def: ComponentDef): void {
    this.refuseFrozen("remove");
    if (this.world.guard !== undefined) {
      this.world._guardWrites([def], "removed");
    }
    this.ops.push({ op: "remove", entity, def });
  }

  /** Refuses a command in a frozen world, since it would still change the world later. */
  private refuseFrozen(op: string): void {
    if (this.world._frozen) {
      throw new Error(frozenWrite(`Commands.${op}()`));
    }
  }

  /** Returns a position in the queue, for `rollback`. */
  mark(): number {
    return this.ops.length;
  }

  /**
   * Discards every command queued since `mark`. The ids of entities whose spawn
   * is discarded are returned to the pool, newest first, so the world is left
   * as if they were never requested: the next entities get the same ids either
   * way.
   */
  rollback(mark: number): void {
    for (let i = this.ops.length - 1; i >= mark; i--) {
      const cmd = this.ops[i]!;
      if (cmd.op === "spawn") {
        this.world._release(cmd.entity, cmd.fresh);
      }
    }
    this.ops.length = Math.min(this.ops.length, mark);
  }

  /** Applies queued commands in order, and returns how many were applied. */
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
