/**
 * Queries over a world: the tables and sparse sets that match a description,
 * and the loops that visit their rows.
 *
 * No Effect dependency.
 */
import { ChangeLog } from "./changes";
import type { ChangeCursor, ChangeKind, SavedChanges } from "./changes";
import type { Column } from "./column";
import { INDEX_MASK, entityOf, makeAccessor, retarget } from "./component";
import type {
  Absent,
  Accessor,
  AccessorsOf,
  Chunked,
  ColumnsOf,
  ComponentDef,
  Entity,
  ReadOnlyTerm,
  ReadonlyColumn,
  ReadonlyColumnsOf,
  Row,
  Schema,
} from "./component";
import { SparseSet, Table } from "./table";
import type { World } from "./world";

/**
 * Describes a query as text: how a save identifies a change query.
 * @internal
 */
export const describeSpec = (spec: QuerySpec): string => {
  const names = (defs: readonly ComponentDef[] | undefined): string =>
    (defs ?? []).map((def) => def.name).join(",");
  // What it only reads, in the order of its terms, however it was said.
  const reads = spec.terms.filter(
    (def: ComponentDef) => spec.readDefs?.includes(def) === true
  );
  // Said only when there is one, so that the readers of a save made before
  // there were any keep their keys.
  const maybe =
    (spec.maybeDefs?.length ?? 0) > 0 ? ` maybe(${names(spec.maybeDefs)})` : "";
  return `all(${names(spec.terms)})${maybe} with(${names(spec.withDefs)}) without(${names(spec.withoutDefs)}) changed(${names(spec.changedDefs)}) added(${names(spec.addedDefs)}) reads(${names(reads)})`;
};

/**
 * Renames a component in saved changes: the changes of it, and the queries
 * that name it in their readers' keys, so each reader goes on from its place.
 * @internal
 */
export const renameInChanges = (
  saved: readonly SavedChanges[],
  from: string,
  to: string
): SavedChanges[] => {
  const renamed = (key: string): string => {
    // A query's reader is `${who}\n${describeSpec(spec)}`; a removal's has no query.
    const at = key.indexOf("\n");
    return at === -1
      ? key
      : key.slice(0, at) +
          key.slice(at).replaceAll(
            /\(([^)]*)\)/g,
            (_, names: string) =>
              `(${names
                .split(",")
                .map((name) => (name === from ? to : name))
                .join(",")})`
          );
  };
  return saved.map((changes) => ({
    ...changes,
    component: changes.component === from ? to : changes.component,
    readers: Object.fromEntries(
      Object.entries(changes.readers).map(([key, read]) => [renamed(key), read])
    ),
  }));
};

/**
 * The components whose data a query hands to its loop, in the order the loop
 * receives them.
 *
 * @category Models
 */
export type Terms = readonly ComponentDef[];

/**
 * What only `Query` has, so that nothing else is a `QuerySpec`.
 *
 * @category Type-level
 */
export declare const Described: unique symbol;

/**
 * A description of a query, independent of any world, which `World.view`
 * resolves against a world. `Query` alone makes one: `Query.all` from
 * `arcadekit`, which a system can also `yield*`.
 *
 *   const Moving = Query.all(Position, Velocity).pipe(Query.without(Stunned), Query.writes(Position))
 *   world.view(Moving).each((position, velocity) => { position.x += velocity.x })
 *
 * @category Models
 */
export interface QuerySpec<D extends Terms = Terms> {
  readonly [Described]: true;
  /**
   * The components whose data the query hands to its loop, table or sparse.
   * An entity must have each of them, but those of `maybeDefs`.
   */
  readonly terms: D;
  /** More components an entity must have, whose data the loop doesn't get. */
  readonly withDefs: readonly ComponentDef[];
  /** Components an entity must not have. */
  readonly withoutDefs: readonly ComponentDef[];
  /**
   * Components to watch for writes. A description with any of these, or any
   * `addedDefs`, is a change query's: it visits only the entities that had one
   * of them written or added since its last visit. An entity must have each
   * of them. See `World.view`.
   */
  readonly changedDefs?: readonly ComponentDef[];
  /** Components to watch for being added. An entity must have each of them. */
  readonly addedDefs?: readonly ComponentDef[];
  /**
   * The terms the query only reads. An assignment to one of them through
   * `each` throws. `eachChunk` doesn't count their rows as written for the
   * change queries that watch them. A transaction doesn't save their columns,
   * since there is nothing to restore. Each is one of `terms`.
   */
  readonly readDefs?: readonly ComponentDef[];
  /**
   * The terms an entity may lack. Each is one of `terms`, stored in tables.
   * For a table without one, the loop gets `undefined` in its place.
   */
  readonly maybeDefs?: readonly ComponentDef[];
}

/**
 * The columns of a sparse component, as `eachChunk` hands them out. Their rows
 * are not the table's, so look up each entity's row:
 * `burning.columns.seconds[burning.indexOf(entity)]`.
 *
 * @typeParam S the component's fields
 * @typeParam C its columns, read-only for a term the query only reads
 *
 * @category Models
 */
export interface SparseColumns<S extends Schema, C = ColumnsOf<S>> {
  /** One column per field. */
  readonly columns: C;
  /**
   * Returns an entity's row in `columns`, for an entity that has the
   * component. For any other entity, the number means nothing.
   */
  readonly indexOf: (entity: Entity) => number;
}

/** A column `eachChunk` hands out as read-only, and what it held before the loop. */
interface ReadOnlyCopy {
  readonly term: number;
  readonly field: string;
  readonly column: Column;
  readonly copy: Column;
}

/**
 * The ids of a table's entities, one per row, as `eachChunk` hands them out.
 * An element reads as an `Entity`.
 *
 * @category Models
 */
export type EntityColumn = ReadonlyColumn<Entity>;

export type ColumnSetsOf<D extends Terms> = {
  [K in keyof D]: D[K] extends ComponentDef<infer S extends Schema, infer St>
    ? | (St extends "sparse"
          ? SparseColumns<
              S,
              D[K] extends ReadOnlyTerm ? ReadonlyColumnsOf<S> : ColumnsOf<S>
            >
          : D[K] extends ReadOnlyTerm
            ? ReadonlyColumnsOf<S>
            : ColumnsOf<S>)
      | Absent<D[K]>
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
  readonly fields: (object | undefined)[];
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
 * A query resolved against one world, as `World.view` returns it and a system
 * gets it from `yield* SomeQuery`. `each` and `eachChunk` visit the entities
 * that match, and `count` and `entities` read them.
 *
 * Every visit goes in the same order: tables in the order they were created,
 * and the rows of each table in order.
 *
 * **Gotchas**
 *
 * A view obtained before `World.restore` throws when it is used. Obtain it
 * again, as a system does every tick.
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
  /** The table components a loop is handed to write, by id, and the sparse sets. */
  private readonly writesIds: number[] = [];
  private readonly writesSets: SparseSet[] = [];
  /** Per term: its sparse set, or undefined when the term is a table component. */
  private readonly termSet: (SparseSet | undefined)[] = [];
  /** The indexes of the sparse terms among the terms. */
  private readonly sparseTerms: number[] = [];
  /** For each term, true when the query only reads it. */
  private readonly termRead: boolean[] = [];
  /**
   * For each term, the fields `eachChunk` hands out as read-only columns: every
   * field of a term the query only reads, and a relation's `target`.
   */
  private readonly readOnlyFields: (readonly string[])[] = [];
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
    /** The description this view resolves. */
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
    for (const def of spec.terms) {
      const read = spec.readDefs?.includes(def) === true;
      this.termRead.push(read);
      this.readOnlyFields.push(
        read ? def.fields : def.relation === undefined ? [] : ["target"]
      );
      if (def.storage === "table") {
        // A term an entity may lack doesn't decide which tables match.
        if (spec.maybeDefs?.includes(def) !== true) {
          this.requiredIds.push(def.id);
        }
        this.termTableId.push(def.id);
        this.termSet.push(undefined);
        if (!read) {
          this.writesIds.push(def.id);
        }
      } else {
        // Reading a sparse component's data implies requiring it.
        this.sparseTerms.push(this.termTableId.length);
        this.termTableId.push(-1);
        const set = requireSparse(def);
        this.termSet.push(set);
        if (!read) {
          this.writesSets.push(set);
        }
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
        "A query's view was used after its world was restored from a snapshot. What it held is gone with the tables it was made of. Ask for it again: yield* the query, as a system does every tick, or yield* app.read(query) outside the game, or world.view(spec) with the storage core."
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
      // What is only read is not written, and need not be put back, and a
      // table without a term has nothing of it to put back.
      const columns = id === -1 ? undefined : table.columns[id];
      if (columns !== undefined && !this.termRead[k]) {
        this.world._saveColumns(
          this.spec.terms[k]!,
          columns,
          table.count,
          table
        );
      }
    }
  }

  /** Notes that a loop was handed this table's columns to write: once per table, never per entity. */
  private wroteTableTerms(table: Table, now: number): void {
    const ids = this.writesIds;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      // A table without a term an entity may lack has nothing of it written.
      if (table.columns[id] !== undefined) {
        table.versions[id] = now;
      }
    }
  }

  /** Notes that a loop was handed the sparse terms' columns to write. */
  private wroteSparseTerms(now: number): void {
    const sets = this.writesSets;
    for (let i = 0; i < sets.length; i++) {
      sets[i]!.changed = now;
    }
  }

  /** Saves the columns of this query's sparse terms. */
  private saveSparseTerms(): void {
    for (let k = 0; k < this.n; k++) {
      const set = this.termSet[k];
      if (set !== undefined && !this.termRead[k]) {
        this.world._saveColumns(set.def, set.columns, set.count, set);
      }
    }
  }

  // --- each: one callback per entity, through accessors -----------------------

  /**
   * Calls `fn` once for each matching entity, with an accessor for each term
   * and then the entity's id. An accessor has the fields of its component, and
   * reads and writes them for the current entity. A term of `maybeDefs` is
   * `undefined` instead for the entities of a table that doesn't have it.
   *
   * The loop reuses the accessors from one call to the next. Read and write
   * through them inside the callback, and don't keep them. An assignment
   * throws for a term the query only reads, and in a frozen world.
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
      const now = world._now;
      if (!world._frozen) {
        this.wroteSparseTerms(now);
      }
      let bound: Table | undefined;
      this.runs(frame, (table, start, end) => {
        if (table !== bound) {
          // Unless they are pointed at it already, from the last time.
          if (loop.table !== table.entities) {
            for (let k = 0; k < this.n; k++) {
              const id = this.termTableId[k]!;
              if (id !== -1) {
                const columns = table.columns[id];
                if (columns === undefined) {
                  loop.fields[k] = undefined;
                } else {
                  acc[k]!.bind(columns, table.entities, termLog[k]);
                  loop.fields[k] = acc[k]!.fields;
                }
              }
            }
            loop.table = table.entities;
          }
          // Once per table, never per entity.
          if (world._recording) {
            this.saveTableTerms(table);
          }
          if (!world._frozen) {
            this.wroteTableTerms(table, now);
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
   * Calls `fn` with the raw columns of each run of matching rows,
   * `[start, end)` of one table. You write the loop yourself:
   *
   *   view.eachChunk((start, end, pos, vel) => {
   *     for (let i = start; i < end; i++) pos.x[i] += vel.x[i] * dt
   *   })
   *
   * A query that names no sparse component, and is not a change query, gets
   * one run per table. Any other query splits each table into runs of
   * consecutive matching rows.
   *
   * A sparse term arrives as `{ columns, indexOf }`, since its rows are not
   * the table's. A term of `maybeDefs` arrives as `undefined` for a table that
   * doesn't have it. After the terms comes `entities`, the ids of the table's
   * rows.
   *
   * Under `noUncheckedIndexedAccess`, a read from a column is `number |
   * undefined` and needs an assertion, `pos.x[i]!`. A checked read would cost
   * a call per read.
   *
   * Raw columns can't say which rows were written. When a change query
   * watches one of this query's terms, every row handed out counts as written,
   * unless the query only reads the term (`readDefs`). For the same reason, a
   * change query can't hand out a component it watches unless it only reads
   * it. A query made with `Query.changed` and `Query.writes` of the same
   * component doesn't compile, and one that names it as a `ComponentDef`,
   * whose name the compiler knows only as `string`, throws. In a frozen world
   * nothing counts as written, so neither applies.
   *
   * In an app made with `verifyFrames`, a loop that wrote a column it was handed
   * read-only throws when it returns, and the column is put back.
   */
  eachChunk(
    this: Chunked<D> & QueryView<D>,
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
      const now = world._now;
      if (!world._frozen) {
        this.wroteSparseTerms(now);
      }
      const kept = world._checkReads ? this.keepReadOnly() : undefined;
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
          if (!world._frozen) {
            this.wroteTableTerms(table, now);
          }
          bound = table;
        }
        const ents = table.entities;
        if (noting) {
          // Raw columns cannot say which rows were written, so every row
          // that is handed out counts as written.
          for (let k = 0; k < n; k++) {
            if (cols[k] !== undefined) {
              this.termLog[k]?.noteRows(ents, start, end);
            }
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
      if (kept !== undefined) {
        this.refuseReadOnlyWrites(kept);
      }
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
          `eachChunk() was called on a query that watches "${log.def.name}" for changes and also hands it out. Raw columns cannot tell a read from a write, so every row handed out counts as written, and the query would see its own visit as a change every time. Visit it with each(), whose accessors note only the rows they assign to; or, if the loop only reads "${log.def.name}", leave it out of Query.writes (readDefs); or take it out of the query's terms.`
        );
      }
    }
  }

  /** Copies every column `eachChunk` is about to hand out as read-only. */
  private keepReadOnly(): ReadOnlyCopy[] {
    const kept: ReadOnlyCopy[] = [];
    for (let k = 0; k < this.n; k++) {
      const set = this.termSet[k];
      const id = this.termTableId[k]!;
      const held =
        set === undefined
          ? this.tables.flatMap((table) => {
              const columns = table.columns[id];
              return columns === undefined
                ? []
                : [{ columns, count: table.count }];
            })
          : [set];
      for (const { columns, count } of held) {
        for (const field of this.readOnlyFields[k]!) {
          const column = columns[field]!;
          kept.push({ term: k, field, column, copy: column.slice(0, count) });
        }
      }
    }
    return kept;
  }

  /**
   * Refuses a loop that wrote a column it was handed as read-only, which only
   * a cast lets through, and puts back what the column held.
   */
  private refuseReadOnlyWrites(kept: readonly ReadOnlyCopy[]): void {
    const written = kept.find(({ column, copy }) => {
      for (let i = 0; i < copy.length; i++) {
        if (!Object.is(column[i], copy[i])) {
          return true;
        }
      }
      return false;
    });
    if (written === undefined) {
      return;
    }
    for (const { column, copy } of kept) {
      if (Array.isArray(column)) {
        for (let i = 0; i < copy.length; i++) {
          column[i] = copy[i];
        }
      } else if (!Array.isArray(copy)) {
        column.set(copy);
      }
    }
    const def = this.spec.terms[written.term]!;
    throw new Error(
      this.termRead[written.term]
        ? `eachChunk() wrote "${def.name}.${written.field}", which the query only reads, through its raw column. No change query would see the write, and no refusal would undo it, so it has been put back. Name "${def.name}" in Query.writes to write it, or write it with each().`
        : `eachChunk() wrote the target of "${def.name}" through its raw column, and it has been put back. ${retarget(def.name)}`
    );
  }

  // --- conveniences -----------------------------------------------------------

  /**
   * Returns the number of matching entities. For a change query, it returns
   * how many entities the query has yet to visit, and counting is not a visit.
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
   * Returns the matching entities in the order a loop visits them, as a new
   * array. For a change query, the call is a visit, as `each` is.
   */
  entities(): Entity[] {
    const out: Entity[] = [];
    if (this.watching) {
      const frame = this.enter();
      try {
        this.runs(frame, (table, start, end) => {
          for (let i = start; i < end; i++) {
            out.push(entityOf(table.entities[i]!));
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
          out.push(entityOf(table.entities[i]!));
        }
      }
    }
    return out;
  }
}
