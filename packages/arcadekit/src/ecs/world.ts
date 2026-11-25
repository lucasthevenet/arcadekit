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
 *
 * No Effect dependency.
 */
import { ChangeLog, RemovedReader } from "./changes.ts";
import type { ChangeCursor, ChangeKind, SavedChanges } from "./changes.ts";
import type { Column } from "./column.ts";
import {
  GENERATIONS,
  INDEX_MASK,
  definedComponent,
  entityIndex,
  entityOf,
  frozenWrite,
  idOf,
  isBoxed,
  isComponentDef,
  makeEntity,
  refuseRetarget,
  targetOf,
  targetless,
} from "./component.ts";
import type {
  ComponentDef,
  ComponentInput,
  ComponentValue,
  Entity,
  Schema,
  SingletonSpec,
  ValueOf,
} from "./component.ts";
import { read, write } from "./format.ts";
import type { SnapshotStore } from "./format.ts";
import {
  add,
  addColumn,
  addColumnPerRow,
  addData,
  addString,
  finish,
  shapeOf,
} from "./hash.ts";
import { QueryView, describeSpec } from "./query.ts";
import type { QuerySpec, Terms } from "./query.ts";
import { Rng } from "./random.ts";
import { NOT_PLACED, WHOLE } from "./records.ts";
import type { Saved, Single } from "./records.ts";
import type { PatchOf, RelationDef, Targeted } from "./relation.ts";
import { STORAGES, SnapshotError, WIDTH, corrupt } from "./snapshot.ts";
import type { Store } from "./store.ts";
import type { Columns, Kept, KeptSet, Versions } from "./table.ts";
import {
  RelationIndex,
  SparseSet,
  Table,
  byName,
  makeColumns,
  nodeOf,
  readRow,
  tableNode,
  writeRow,
} from "./table.ts";

const FREE = -2;
/** The number of slots: what an id's generation is multiplied by. */
const SLOTS = INDEX_MASK + 1;
/** What `hash` folds in before each singleton, to distinguish it from a sparse set. */
const SINGLETON = 0x53_49_4e_47;
/** A singleton's row as a moment keeps it: without its `transient` fields. */
const keptRow = (single: Single): Record<string, unknown> => {
  const { def } = single;
  const row: Record<string, unknown> = {};
  for (let f = 0; f < def.fields.length; f++) {
    if (def.kinds[f] !== "transient") {
      row[def.fields[f]!] = single.columns[def.fields[f]!]![0];
    }
  }
  return row;
};

/** The hash of rows `[0, count)` of a component's columns, on its own. */
const rowsHash = (
  def: ComponentDef,
  columns: Columns,
  count: number
): number => {
  let h = 0;
  for (let f = 0; f < def.fields.length; f++) {
    h = addColumn(
      h,
      def.kinds[f]!,
      columns[def.fields[f]!]!,
      count,
      def.codecs[f]
    );
  }
  return finish(h);
};

const storageOf = (def: ComponentDef): 0 | 1 | 2 =>
  def.single ? 2 : def.storage === "sparse" ? 1 : 0;

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/**
 * @internal
 * A world at one moment, held in memory: what `_capture` returns and `_rewind`
 * takes. What did not change since the moment before is shared with it.
 */
export interface Moment {
  /** The world's version when it was captured: what changed since is later. */
  readonly at: number;
  /** Every table there was, in order. */
  readonly tables: readonly Kept[];
  /** Every sparse set there was. */
  readonly sets: readonly KeptSet[];
  /** The singletons that had been written, with a copy of their one row. */
  readonly singles: readonly (readonly [
    Single,
    Readonly<Record<string, unknown>>,
  ])[];
  /** The ids to come: `nextIndex`, and the freed slots with their generations. */
  readonly slots: number;
  readonly alive: number;
  readonly freed: readonly number[];
  readonly freedGens: Uint32Array;
  readonly random: Uint32Array;
  /** What each store captured of itself. */
  readonly stores: readonly (readonly [Store, unknown])[];
  /** Where the trail was: what the change logs hold from then on. */
  readonly trail: Trail;
}

/**
 * What the change logs held between one capture and the next, and what they
 * held after: a list only moments hold the start of, so what no moment can go
 * back to is forgotten. A rewind with readers to take back finds in it what
 * the future it gives up changed.
 */
interface Trail {
  /** Which run of the trail it is of: `restore` starts another. */
  readonly run: number;
  /** The logs there were when it began, by `logKey`. */
  readonly watched: ReadonlySet<number>;
  changes: {
    readonly def: ComponentDef;
    readonly kind: ChangeKind;
    readonly entries: Uint32Array | Float64Array;
  }[];
  next: Trail | undefined;
  /** True once a rewind has given it up. */
  dead: boolean;
}

const KINDS: readonly ChangeKind[] = ["changed", "added", "removed"];
const logKey = (def: ComponentDef, kind: ChangeKind): number =>
  def.id * KINDS.length + KINDS.indexOf(kind);

/**
 * What a rewind's readers are given, ahead of what the moment holds for the
 * others, who are placed past it. An entity past the moment's last slot was
 * spawned in the future given up, and is gone.
 */
const ahead = (
  given: readonly SavedChanges[],
  held: readonly SavedChanges[],
  slots: number
): SavedChanges[] => {
  const byLog = new Map(
    given.map((changes) => [
      `${changes.kind}\n${changes.component}`,
      {
        ...changes,
        entries: changes.entries.filter((index) => index < slots),
      },
    ])
  );
  const out = held.map((changes) => {
    const key = `${changes.kind}\n${changes.component}`;
    const first = byLog.get(key);
    if (first === undefined) {
      return changes;
    }
    byLog.delete(key);
    const offset = first.entries.length;
    return {
      ...changes,
      entries: [...first.entries, ...changes.entries],
      readers: {
        ...first.readers,
        ...Object.fromEntries(
          Object.entries(changes.readers).map(([key, at]) => [key, at + offset])
        ),
      },
    };
  });
  return [...out, ...byLog.values()];
};

/**
 * A world of entities and their components: the tables and sparse sets that
 * store them, its singletons, its change logs and its random generator. An
 * app holds one, and its systems reach it through the `World` service.
 *
 *   const world = new World({ seed: 7 })
 *   const rock = world.spawn(Position.of({ x: 0, y: 0 }))
 *   world.set(rock, Position, { x: 2 })
 *   world.get(rock, Position)                  // { x: 2, y: 0 }
 *
 * Entities with the same set of table components share a table, with one
 * column per field. While a query iterates or a transaction is open, the
 * world refuses a spawn, a despawn, an add or a remove. Queue them on a
 * `CommandBuffer` there, and apply it afterwards. A frozen world refuses
 * changes too: see `freeze`.
 *
 * **When to use**
 *
 * Use to run the storage core without an app, in a tool, a benchmark or a
 * test of plain code. `arcadekit` exports the class as `EcsWorld`.
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
  /** What every table, sparse set, relation index and singleton notes when it changes. */
  private readonly version: Versions = { now: 1 };
  /** @internal The version a write notes now. */
  get _now(): number {
    return this.version.now;
  }
  private readonly tableRoot = tableNode();
  private readonly sparseById = new Map<number, SparseSet>();
  private readonly sparseList: SparseSet[] = [];
  private views = new WeakMap<QuerySpec, QueryView>();
  private readonly componentsByName = new Map<string, ComponentDef>();
  /** Indexed by component id: true once registered, so the common check is a single read. */
  private readonly registered: (true | undefined)[] = [];
  /** Indexed by component id: what `hash` folds in for the component itself. */
  private readonly shapes: number[] = [];
  /** The sparse sets in order of component name, rebuilt when one is created. */
  private sparseByName: SparseSet[] | undefined;
  /** Indexed by component id: where in a spawn's inputs it may be, for `_place`. */
  private readonly placedAt: number[] = [];
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
   * The current reader, which a change query or a `removed` reader belongs to
   * when none is given. An app sets it before each system and handler runs, so
   * that each has its own place in every change log.
   */
  reader: string | undefined;
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
  private watchViews = new WeakMap<QuerySpec, Map<string, QueryView>>();
  private readonly viewsByKey = new Map<string, QueryView>();
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
   * every random number a simulation draws comes from here.
   */
  readonly random: Rng;

  /** @internal True between `begin` and `commit` or `rollback`. */
  _recording = false;
  /** @internal True between `freeze` and `thaw`. */
  _frozen = false;
  /**
   * @internal When true, `eachChunk` refuses a loop that wrote a column it
   * handed out as read-only, at the cost of a copy and a comparison of each.
   */
  _checkReads = false;
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
  /** What was attached, in order of name: `_attach`. */
  private stores: readonly Store[] = [];
  /** The moments this world captured: `_rewind` takes no other. */
  private readonly moments = new WeakSet<Moment>();
  /**
   * Where what the logs hold since the last capture goes, once there was one.
   * Only moments hold it: once none is left, nothing is kept for one.
   */
  private trail: WeakRef<Trail> | undefined;
  /** The run of the trail: a moment of another can't find its way in it. */
  private trails = 0;
  /** The random generator's state when the world was frozen. */
  private readonly frozenRandom = new Uint32Array(4);

  /**
   * Makes an empty world. `seed`, an integer from 0 to
   * `Number.MAX_SAFE_INTEGER`, is where its random sequence starts, and
   * defaults to 0. Any other seed throws.
   */
  constructor(options?: { readonly seed?: number }) {
    this.random = new Rng(options?.seed ?? 0);
  }

  /**
   * The number of live entities, counting those a `CommandBuffer` spawned and
   * hasn't applied yet.
   */
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
   * despawned, it returns false for good, since the slot is reused under
   * another generation, and so under another id.
   */
  isAlive(entity: Entity.Ref): boolean {
    const index = entityIndex(entity);
    // The generation, compared without rounding it down: a number that is
    // no id, which has a part below its index's bits or none at all, is the
    // generation of no slot.
    return (
      index < this.nextIndex &&
      this.recTable[index] !== FREE &&
      this.gens[index] === (idOf(entity) - index) / SLOTS
    );
  }

  /**
   * Returns the entity a `Field.entity` value refers to while it is alive, and
   * undefined once it is despawned, even after another entity takes its slot.
   */
  live(ref: Entity.Ref): Entity | undefined {
    if (!this.isAlive(ref)) {
      return undefined;
    }
    const index = entityIndex(ref);
    return makeEntity(index, this.gens[index]!);
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
    const placing: ComponentInput[] = [];
    const tableDefs: ComponentDef[] = [];
    // Later inputs win when the same component is given twice.
    let requiring = false;
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!;
      this.placeInput(placing, input, 0);
      if ((isComponentDef(input) ? input : input.def).requires.length > 0) {
        requiring = true;
      }
    }
    // What they require and none gives: of two that require one, the later's value.
    if (requiring) {
      const given = placing.length;
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i]!;
        for (const required of (isComponentDef(input) ? input : input.def)
          .requires) {
          this.placeInput(placing, required, given);
        }
      }
    }
    for (let i = 0; i < placing.length; i++) {
      const input = placing[i]!;
      const def = isComponentDef(input) ? input : input.def;
      // Kept in order of id as they come: `sort` measured half again a spawn
      // and despawn.
      if (def.storage === "table") {
        let at = tableDefs.length;
        for (; at > 0 && tableDefs[at - 1]!.id > def.id; at--) {
          tableDefs[at] = tableDefs[at - 1]!;
        }
        tableDefs[at] = def;
      }
    }
    const table = this.tableFor(tableDefs);
    const row = table.push(entity);
    let related: ComponentValue[] | undefined;
    for (const input of placing) {
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

  /**
   * Puts an input in `placing`, or in place of the one of the same component
   * that is there, when that one is at `from` or later.
   */
  private placeInput(
    placing: ComponentInput[],
    input: ComponentInput,
    from: number
  ): void {
    const { id } = isComponentDef(input) ? input : input.def;
    const at = this.placedAt[id];
    if (at !== undefined && at < placing.length) {
      const there = placing[at]!;
      if ((isComponentDef(there) ? there : there.def).id === id) {
        if (at >= from) {
          placing[at] = input;
        }
        return;
      }
    }
    this.placedAt[id] = placing.length;
    placing.push(input);
  }

  /** Records the relations an entity was spawned with. */
  private placeRelations(entity: Entity, related: ComponentValue[]): void {
    const index = entityIndex(entity);
    let gone = false;
    const dangling: ComponentDef[] = [];
    for (const { def, value } of related) {
      const target = targetOf(value);
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
   * Creates an entity with these components and returns its id. A component
   * given twice takes the later value. Like every structural change, it throws
   * while a query is iterating and inside a transaction, where a
   * `CommandBuffer` queues it instead, and while the world is frozen.
   */
  spawn<const I extends readonly ComponentInput[]>(
    ...inputs: { readonly [K in keyof I]: I[K] & Targeted<I[K]> }
  ): Entity {
    this.assertNotIterating("spawn");
    // Before an id is reserved, so a refused component leaves nothing behind.
    this._registerAll(inputs);
    const entity = this._reserve();
    this._place(entity, inputs);
    return entity;
  }

  /**
   * Despawns an entity, and returns false when it was gone already. The
   * entities that point at it with a relation are despawned too, at any depth,
   * or lose the relation, as the relation's `onTargetDespawn` says. Relations
   * are processed in order of name, and the entities that point at it in order
   * of index, so the same world always loses the same entities in the same
   * order.
   */
  despawn(entity: Entity): boolean {
    this.assertNotIterating("despawn");
    if (!this.isAlive(entity)) {
      return false;
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
    let doomed: Entity[] | undefined;
    for (const relation of this.relationList) {
      if (!relation.pointedAt(index)) {
        continue;
      }
      // Each is unlinked as it loses the relation, or is despawned.
      for (const source of relation.sources(index)) {
        const holder = makeEntity(source, this.gens[source]!);
        if (relation.def.relation === "despawn") {
          (doomed ??= []).push(holder);
        } else {
          this.removeOne(holder, relation.def);
        }
      }
    }
    if (doomed !== undefined) {
      for (let i = doomed.length - 1; i >= 0; i--) {
        pending.push(doomed[i]!);
      }
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
          removedLogs[def.id]?.push(idOf(entity));
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
        removedLogs[set.def.id]?.push(idOf(entity));
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
   * Adds a component to an entity, or overwrites the one it has when given a
   * value. Adding a relation again gives it a new target. Returns false when
   * the entity is gone, or when a relation's target is. In that second case,
   * the world does at once what the target's despawn would have done.
   */
  add<const I extends ComponentInput>(
    entity: Entity,
    input: I & Targeted<I>
  ): boolean {
    this.assertNotIterating("add");
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
    const target = targetOf(value);
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
    if (def.requires.length > 0) {
      return this.addRequiring(index, entity, def, value);
    }
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
        from.versions[def.id] = this.version.now;
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

  /**
   * Adds a component that requires others, with those the entity lacks, in
   * one move: the table it moves to is kept on the edge, as for any add.
   */
  private addRequiring(
    index: number,
    entity: Entity,
    def: ComponentDef,
    value: Readonly<Record<string, unknown>> | undefined
  ): boolean {
    const from = this.placedTable(index);
    let to = from.addEdges.get(def.id);
    if (to === undefined) {
      const defs = new Map(from.defs.map((d) => [d.id, d]));
      if (def.storage === "table") {
        defs.set(def.id, def);
      }
      for (const required of def.requires) {
        const filled = isComponentDef(required) ? required : required.def;
        if (filled.storage === "table") {
          defs.set(filled.id, filled);
        }
      }
      to = this.tableFor([...defs.values()].sort((a, b) => a.id - b.id));
      from.addEdges.set(def.id, to);
    }
    const row = to === from ? this.recRow[index]! : this.move(entity, from, to);
    for (const required of def.requires) {
      const filled = isComponentDef(required) ? required : required.def;
      const given = isComponentDef(required) ? undefined : required.value;
      if (filled.storage === "table") {
        if (from.ids.has(filled.id)) {
          continue;
        }
        writeRow(filled, to.columns[filled.id]!, row, given);
      } else {
        const set = this._sparse(filled);
        if (set.has(index)) {
          continue;
        }
        set.add(index, given);
      }
      this.addedLogs[filled.id]?.note(index);
      this._changed[filled.id]?.note(index);
    }
    if (def.storage === "sparse") {
      const set = this._sparse(def);
      const had = set.has(index);
      set.add(index, value);
      if (!had) {
        this.addedLogs[def.id]?.note(index);
      }
      if (!had || value !== undefined) {
        this._changed[def.id]?.note(index);
      }
    } else if (!from.ids.has(def.id)) {
      writeRow(def, to.columns[def.id]!, row, value);
      this.addedLogs[def.id]?.note(index);
      this._changed[def.id]?.note(index);
    } else if (value !== undefined) {
      to.versions[def.id] = this.version.now;
      writeRow(def, to.columns[def.id]!, row, value);
      this._changed[def.id]?.note(index);
    }
    return true;
  }

  /**
   * Removes a component from an entity. Returns false when the entity is gone
   * or didn't have the component.
   */
  remove(entity: Entity, def: ComponentDef): boolean {
    this.assertNotIterating("remove");
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
      this.removedLogs[def.id]?.push(idOf(entity));
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
    this.removedLogs[def.id]?.push(idOf(entity));
    return true;
  }

  /** Returns whether an entity is alive and has a component. */
  has(entity: Entity, def: ComponentDef): boolean {
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

  /**
   * Returns a copy of an entity's component as a plain object, or undefined
   * when the entity is gone or doesn't have the component. It makes an object
   * per call, so a loop over many entities uses a query instead.
   */
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
   * Returns a copy of what the world holds, as plain objects. `entities` has
   * every live entity in order of index, with each of its components by name.
   * `singletons` has every singleton the world has read or written, by name.
   * `stores` has what each store attached to the world holds, by the store's
   * name.
   *
   * It reads every component of every entity, so it is for tools and not for
   * a system.
   */
  contents(): {
    readonly entities: readonly {
      readonly id: Entity;
      readonly components: Readonly<Record<string, object>>;
    }[];
    readonly singletons: Readonly<Record<string, object>>;
    readonly stores: Readonly<Record<string, unknown>>;
  } {
    const sparse = [...this.sparseById.values()].toSorted((a, b) =>
      byName(a.def, b.def)
    );
    const entities: { id: Entity; components: Record<string, object> }[] = [];
    for (let index = 0; index < this.nextIndex; index++) {
      const id = makeEntity(index, this.gens[index]!);
      if (!this.isAlive(id)) {
        continue;
      }
      const components: Record<string, object> = {};
      const tableIndex = this.recTable[index]!;
      if (tableIndex !== NOT_PLACED) {
        const table = this.tables[tableIndex]!;
        for (const def of table.defsByName) {
          components[def.name] = readRow(
            def,
            table.columns[def.id]!,
            this.recRow[index]!
          );
        }
      }
      for (const set of sparse) {
        if (set.has(index)) {
          components[set.def.name] = readRow(
            set.def,
            set.columns,
            set.sparse[index]!
          );
        }
      }
      entities.push({ id, components });
    }
    const singletons: Record<string, object> = {};
    for (const single of this.singles
      .filter((found) => found !== undefined)
      .toSorted((a, b) => byName(a.def, b.def))) {
      singletons[single.def.name] = readRow(single.def, single.columns, 0);
    }
    const stores: Record<string, unknown> = {};
    for (const store of this.stores) {
      const held = store.contents();
      if (held !== undefined) {
        stores[store.name] = held;
      }
    }
    return { entities, singletons, stores };
  }

  /**
   * Writes some or all fields of a component the entity has, and returns
   * false when the entity doesn't have it. A field left out keeps its value.
   * A relation's `target` is not one of the fields: add the relation again to
   * change it.
   */
  set<S extends Schema>(
    entity: Entity,
    def: ComponentDef<S>,
    value: PatchOf<S>
  ): boolean {
    if (!this.has(entity, def)) {
      return false;
    }
    refuseRetarget(def, value);
    if (this._frozen) {
      throw new Error(frozenWrite("World.set()"));
    }
    const index = entityIndex(entity);
    let cols: Columns;
    let row: number;
    let owner: Saved["owner"];
    if (def.storage === "sparse") {
      const set = this._sparse(def);
      set.changed = this.version.now;
      cols = set.columns;
      row = set.sparse[index]!;
      owner = set;
    } else {
      const table = this.tables[this.recTable[index]!]!;
      table.versions[def.id] = this.version.now;
      cols = table.columns[def.id]!;
      row = this.recRow[index]!;
      owner = table;
    }
    if (this._recording) {
      this.saveRow(def, cols, row, owner);
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
   * index, such as a parent's children. Finding them doesn't look at any other
   * entity. To visit them with their components, narrow a view with
   * `QueryView.pointingAt`.
   */
  sources(target: Entity, def: RelationDef): Entity[] {
    const relation = this.relations[def.id];
    if (relation === undefined || !this.isAlive(target)) {
      return [];
    }
    return relation
      .sources(entityIndex(target))
      .map((source) => makeEntity(source, this.gens[source]!));
  }

  /** @internal A relation's index of which entities point at which, if one is stored. */
  _relation(def: ComponentDef): RelationIndex | undefined {
    return this.relations[def.id];
  }

  /** Returns a relation's index of which entities point at which, creating it if needed. */
  private relationOf(def: ComponentDef): RelationIndex {
    let relation = this.relations[def.id];
    if (relation === undefined) {
      relation = new RelationIndex(def, this.version, this.recTable.length);
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
      if (def.relation !== undefined) {
        this.relink(def);
      }
    }
  }

  /** Links the holders of one relation to their targets, from its columns. */
  private relink(def: ComponentDef): void {
    const link = (
      entities: Uint32Array | Float64Array,
      targets: Float64Array,
      count: number
    ): void => {
      for (let row = 0; row < count; row++) {
        const target = entityOf(targets[row]!);
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
      return;
    }
    for (const table of this.tables) {
      const columns = table.columns[def.id];
      if (columns !== undefined) {
        link(table.entities, columns.target as Float64Array, table.count);
      }
    }
  }

  // --- singletons ------------------------------------------------------------

  /**
   * Returns the world's value of a singleton, an object whose fields you read
   * and write in place. It is the same object on every call.
   *
   *   const turn = world.singleton(Turn)
   *   turn.player = turn.player === 1 ? 2 : 1
   *
   * The value is the singleton's initial value until it is written. From then
   * on it is part of the world: a snapshot and the hash include it, and a
   * rollback restores it. Reading it changes nothing, so a world that has only
   * read a singleton hashes the same as one that never read it. Given a
   * component that is not a singleton, it throws.
   */
  singleton<S extends Schema>(spec: SingletonSpec<S>): ValueOf<S> {
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

  /**
   * Returns whether the world holds a singleton as its own: written since the
   * world began, or loaded from a snapshot. Until then the singleton has its
   * initial value, and neither a snapshot nor the hash includes it.
   */
  holds<S extends Schema>(spec: SingletonSpec<S>): boolean {
    return this.singles[spec.component.id]?.written === true;
  }

  /** Returns a singleton's instance, creating it if needed with every field zero. */
  private single(def: ComponentDef): Single {
    let single = this.singles[def.id];
    if (single === undefined) {
      this.register(def);
      const columns = makeColumns(def, 1);
      const value = {};
      single = {
        def,
        columns,
        initial: undefined,
        written: false,
        value,
        version: this.version.now,
        hash: 0,
        hashedAt: -1,
      };
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
    if (this._recording && !this.savedWhole.has(single.columns)) {
      this.savedSingles.push({ single, written: single.written });
      this._saveColumns(single.def, single.columns, 1, single);
    }
    single.written = true;
    single.version = this.version.now;
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
   * Freezes the world. Until `thaw`, it can be read and not changed. Anything
   * that would change it throws and says why: `spawn`, `despawn`, `add`,
   * `remove`, `set`, `begin`, `restore`, a write to a singleton, a command
   * queued on a `CommandBuffer` or applied from one, and an assignment through
   * the accessors of `each`. `freeze` throws inside a transaction.
   *
   * An app freezes its world for the frame stage, which draws the game between
   * two ticks and must leave it unchanged.
   *
   * Some changes aren't stopped where they happen. `thaw` detects a draw from
   * `world.random`, restores the generator, and throws. A write through the
   * raw columns that `eachChunk` hands out is refused only in an app made
   * with `verifyFrames`. A check on either in every world would slow every
   * loop and every draw.
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
   * Ends a freeze. When a random number was drawn from `world.random` during
   * the freeze, it restores the generator, so that the world is as it was, and
   * throws.
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

  // --- transactions ----------------------------------------------------------

  /**
   * Starts a transaction. Until `commit` or `rollback`:
   *
   * - `rollback` can undo every write to component data, through `set`, `each`
   *   and `eachChunk`, every write to a singleton, every random number drawn,
   *   every visit of a change query, and what was done to each store attached
   *   to the world.
   * - `spawn`, `despawn`, `add` and `remove` throw. Queue them on a
   *   `CommandBuffer`, whose own `rollback` discards them. Rows then stay in
   *   place for the whole transaction, so undoing a write is a plain copy.
   *
   * An action's handler runs inside a transaction, so a refused action leaves
   * nothing behind. The world saves what is about to be written: one row for
   * `set`, and for a loop, the columns of the query's terms in each table it
   * visits, once each.
   *
   * An object held in a `ref` field and changed in place isn't restored, since
   * the field still holds the same object. `begin` throws inside a transaction
   * and in a frozen world.
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
    for (const store of this.stores) {
      store.begin();
    }
    this._recording = true;
  }

  /** Ends the transaction and keeps what was written. Throws outside one. */
  commit(): void {
    this.requireTransaction("commit");
    this.endTransaction();
    for (const store of this.stores) {
      store.commit();
    }
  }

  /**
   * Ends the transaction and restores everything written since `begin`.
   * Throws outside one.
   */
  rollback(): void {
    this.requireTransaction("rollback");
    const { saved } = this;
    // Newest first, so that where a row was saved before its whole column,
    // the oldest value is the one left standing.
    const { now } = this.version;
    for (let i = saved.length - 1; i >= 0; i--) {
      const { cols, copies, count, def, owner, row } = saved[i]!;
      if (owner instanceof Table) {
        owner.versions[def.id] = now;
      } else if (owner instanceof SparseSet) {
        owner.changed = now;
      } else {
        owner.version = now;
      }
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
    this.endTransaction();
    for (const store of this.stores) {
      store.rollback();
    }
  }

  private requireTransaction(op: string): void {
    if (!this._recording) {
      throw new Error(
        `World.${op}() was called with no transaction in progress. Call begin() first.`
      );
    }
  }

  private endTransaction(): void {
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
  _saveColumns(
    def: ComponentDef,
    cols: Columns,
    count: number,
    owner: Saved["owner"]
  ): void {
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
    this.saved.push({ cols, copies, count, def, owner, row: WHOLE });
  }

  /** Saves one row of a component's columns. */
  private saveRow(
    def: ComponentDef,
    cols: Columns,
    row: number,
    owner: Saved["owner"]
  ): void {
    if (this.savedWhole.has(cols)) {
      return;
    }
    const copies: unknown[] = [];
    for (let f = 0; f < def.fields.length; f++) {
      copies.push(cols[def.fields[f]!]![row]);
    }
    this.saved.push({ cols, copies, count: 1, def, owner, row });
  }

  /**
   * Registers a component with the world, so that `component` finds it by
   * name. The world registers a component itself the first time it stores or
   * queries it, so a call is needed only to look one up by name before then.
   * Its name is its identity in this world, and a second component with the
   * same name throws.
   */
  register(def: ComponentDef): void {
    if (this.registered[def.id] === true) {
      return;
    }
    // Ahead of the component, once: a component whose requirement is refused
    // is refused again at its next spawn, before an entity is reserved.
    for (const required of def.requires) {
      this.register(isComponentDef(required) ? required : required.def);
    }
    const known = this.componentsByName.get(def.name);
    if (known !== undefined) {
      throw new Error(
        `Two different components are both named "${def.name}". A component's name identifies it in a world and in a save, so give each its own, prefixed with the feature it belongs to.`
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
      if (this.registered[def.id] !== true) {
        this.register(def);
      }
    }
  }

  /**
   * Returns the registered component with this name, or undefined. Saves, the
   * network and tools find components this way.
   */
  component(name: string): ComponentDef | undefined {
    return this.componentsByName.get(name);
  }

  // --- queries -------------------------------------------------------------

  /**
   * Resolves a query description against this world and returns its view. The
   * world keeps one view per description, and returns it again for any object
   * that names the same components in the same places. A change query's view
   * is kept per reader too.
   *
   * A description with `changedDefs` or `addedDefs` is a change query's. Its
   * view visits only the entities that had one of those components written,
   * or gained one, since the view last visited, in the usual order. The first
   * time, it visits every matching entity. `each`, `eachChunk` and `entities`
   * count as visits, and `count` doesn't. When nothing changed, a visit costs
   * a few comparisons.
   *
   * A change query's view belongs to one reader: `reader`, or else
   * `world.reader`, or else an anonymous one. Two readers of the same
   * description each see every change once. Two descriptions that name the
   * same components in the same places share a reader's view.
   *
   * `set`, `add` with a value, and the setters of `each` record a write per
   * row. `eachChunk` hands out raw columns and can't detect writes, so every
   * row it hands out counts as written, except for the terms the description
   * only reads (`readDefs`). The world records writes only to the components
   * that some change query watches.
   */
  view<D extends Terms>(spec: QuerySpec<D>, reader?: string): QueryView<D> {
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
    const key =
      byReader === undefined
        ? describeSpec(spec)
        : `${who}\n${describeSpec(spec)}`;
    view = this.viewsByKey.get(key);
    if (view === undefined) {
      view = new QueryView(this, spec, byReader === undefined ? "" : key);
      this.viewsByKey.set(key, view);
    }
    if (byReader === undefined) {
      this.views.set(spec, view);
    } else {
      byReader.set(who, view);
    }
    return view as QueryView<D>;
  }

  // --- changes ---------------------------------------------------------------

  /**
   * Returns a reader of the entities that lost a component, by `remove` or by
   * being despawned. Its `read` returns those that lost it since the last
   * `read`. The world logs a component's removals from the first time anyone
   * asks for them. There is one reader per name and component: `reader`, or
   * else `world.reader`, or else an anonymous one.
   */
  removed(def: ComponentDef, reader?: string): RemovedReader {
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
      if (this.trail !== undefined) {
        log.kept = 0;
        // An entity that lost the component and is back after a rewind is
        // one to visit again.
        if (kind !== "removed") {
          this._log(def, "removed");
        }
      }
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

  /**
   * Makes `reader` skip what changed so far. Each of its change queries and
   * `removed` readers that has visited before moves to the end of its log, so
   * that its next visit sees only what changes from now on. One that has never
   * visited still sees everything that matches. An app calls `skip` for a
   * system whose condition keeps it from running, so that the system sees
   * nothing of the time it was off.
   */
  skip(reader: string): void {
    for (const log of this.logs) {
      log.skip(reader);
    }
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
   * plain data: one entry per component and kind of change, in order of name.
   * It belongs to the world's readers and not to the world, so the hash never
   * covers it, and a snapshot holds it only when a store attached to the world
   * saves it, as an app's world does. `keep` chooses which readers to save, by
   * name, and all of them are saved without it.
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
   * snapshot taken with it and watches nothing yet. A reader that asks for its
   * changes afterwards goes on from where it was. A reader the save doesn't
   * know starts by visiting everything. Changes to components this world
   * doesn't know are dropped. It throws in a world whose changes are already
   * watched.
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
   * singleton that has been written, the ids to come, the random generator's
   * state, and what each store attached to the world holds, such as an app's
   * queued actions and waiting events. A world with the same stores that
   * loads the bytes hashes the same as this one, and goes on the same way: the
   * same iteration order, the same ids for new entities, the same random
   * numbers.
   *
   * A component is written under its name, with its field names and types, so
   * the bytes don't depend on the order a program defines its components in.
   * Numeric columns are written raw, so a snapshot is about as big as the
   * data: four bytes for an `f32`, and so on.
   *
   * A `json` field is written as the plain data it holds, a `ref` field as its
   * codec's encoding of each value, and a `transient` field not at all. A value
   * that isn't plain data, or that a codec won't encode, has no saved form,
   * and the snapshot throws a `SnapshotError` that names the field. So does a
   * world with a spawn that a `CommandBuffer` queued and hasn't applied.
   */
  snapshot(): Uint8Array {
    return this.snapshotOf(true);
  }

  /** `snapshot()`, with what the stores hold or without it. */
  private snapshotOf(withStores: boolean): Uint8Array {
    this.refuseUnplaced();
    const { tables } = this;
    let estimate = 256 + this.nextIndex * 4 + this.freeList.length * 4;
    for (const table of tables) {
      estimate += 64 + table.count * 8;
      for (const def of table.defs) {
        for (const kind of def.kinds) {
          estimate += table.count * (isBoxed(kind) ? 8 : WIDTH[kind as "f32"]);
        }
      }
    }
    const sets = this.sparseSetsByName().filter((set) => set.count > 0);
    const singles = this.writtenSingles();

    // The components that hold anything, or have a table.
    const used = new Set<ComponentDef>();
    for (const table of tables) {
      for (const def of table.defs) {
        used.add(def);
      }
    }
    for (const set of sets) {
      used.add(set.def);
    }
    for (const single of singles) {
      used.add(single.def);
    }
    const stores: SnapshotStore[] = [];
    if (withStores) {
      for (const store of this.stores) {
        const data = store.save();
        if (data !== undefined) {
          stores.push({ name: store.name, data });
        }
      }
    }
    return write<ComponentDef, Table>({
      estimate,
      random: this.random.state,
      generations: this.gens,
      slots: this.nextIndex,
      freed: this.freeList,
      components: Array.from(used).toSorted(byName),
      storage: storageOf,
      singletons: singles.map((single) => ({
        component: single.def,
        columns: single.columns,
      })),
      stores,
      tables,
      columns: (table, def) => table.columns[def.id]!,
      sparse: sets.map((set) => ({
        component: set.def,
        count: set.count,
        members: set.dense,
        columns: set.columns,
      })),
    });
  }

  /**
   * Replaces everything in this world with a snapshot: the world is emptied,
   * then loaded as `load` loads a new one. It is for a snapshot this world
   * took itself, or one from a world built the same way, since it knows only
   * the components it has met.
   *
   * Afterwards, the world holds what a new world that loaded the snapshot
   * would: the same hash, the same iteration order, the same ids to come, the
   * same random numbers. A singleton's value stays the same object, which
   * holds the snapshot's value, or its initial value when the snapshot doesn't
   * hold it. `world.random` stays the same generator. What each store attached
   * to the world holds is the snapshot's too: in an app's world, the queued
   * actions and the waiting events, with every system's place in them.
   *
   * Nothing made from the old tables survives it. A view or a `removed` reader
   * obtained before throws when it is used. Obtain it again, as a system does
   * every tick. In a world with no app, what change queries hadn't visited is
   * dropped, as in a new world. `restoreChanges` restores what `saveChanges`
   * returned when the snapshot was taken.
   *
   * It throws an `Error` while a query is iterating, inside a transaction,
   * while the world is frozen, and while a `CommandBuffer` holds a spawn it
   * hasn't applied. A snapshot it can't load throws a `SnapshotError`, as for
   * `load`, and a world whose restore failed partway is unusable.
   */
  restore(bytes: Uint8Array): void {
    this.restoring(bytes, true);
  }

  /** `restore`, with what the snapshot holds of the stores or with each empty. */
  private restoring(bytes: Uint8Array, withStores: boolean): void {
    this.refuseRestore();
    if (withStores) {
      // A moment from before has no way to what changed since.
      this.trail = undefined;
      this.trails++;
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
    this.tableRoot.table = undefined;
    this.tableRoot.next.clear();
    this.sparseById.clear();
    this.sparseList.length = 0;
    this.sparseByName = undefined;
    this.relations.length = 0;
    this.relationList = [];
    this.dropViews();
    // The singletons stay the objects they are, as if never written, and the
    // stores the ones that were attached, empty.
    for (const single of this.singles) {
      if (single !== undefined) {
        single.written = false;
        single.version = this.version.now;
        writeRow(single.def, single.columns, 0, single.initial);
      }
    }
    for (const store of this.stores) {
      store.clear();
    }
    this.loading(bytes, withStores);
  }

  /** Throws where the world can't be put back to a snapshot or a moment. */
  private refuseRestore(): void {
    if (this._recording) {
      throw new Error(
        "World.restore() was called between begin() and commit() or rollback(). A transaction puts back what it wrote itself; restore a snapshot outside one."
      );
    }
    // Not in a frozen world either, nor in the middle of a loop.
    this.assertNotIterating("restore");
    const unplaced = this.unplaced();
    if (unplaced > 0) {
      throw new Error(
        `World.restore() was called while ${unplaced} entities were spawned through a CommandBuffer that has not been applied. Their ids would outlive the world they were given in: apply the buffer, or roll it back, first.`
      );
    }
  }

  /** How many live entities a `CommandBuffer` spawned and hasn't placed in a table. */
  private unplaced(): number {
    let placed = 0;
    for (const table of this.tables) {
      placed += table.count;
    }
    return this.alive - placed;
  }

  /** Throws the `SnapshotError` of a world that holds a spawn not applied yet. */
  private refuseUnplaced(): void {
    const unplaced = this.unplaced();
    if (unplaced > 0) {
      throw new SnapshotError(
        "cannot be saved",
        `${unplaced} entities were spawned through a CommandBuffer that has not been applied yet. Apply it, or roll it back, and take the snapshot then.`
      );
    }
  }

  /** Forgets what was made of the tables: views, and what they had yet to visit. */
  private dropViews(): void {
    this._restored++;
    this.views = new WeakMap();
    this.watchViews = new WeakMap();
    this.viewsByKey.clear();
    this.removedReaders.clear();
    this._changed.length = 0;
    this.addedLogs.length = 0;
    this.removedLogs.length = 0;
    this.logs.length = 0;
    this.writeLogs.length = 0;
    this._watched = 0;
    this.lateLogs = [];
  }

  /**
   * Fills this world from a snapshot. The world must be empty: it has never
   * held an entity or written a singleton, and its stores hold nothing.
   *
   * A snapshot names its components, and the world finds each definition by
   * its name: the one this world has met with that name, or else the one this
   * program defined last with it. The world meets `components` first, for a
   * tool that reads a snapshot with definitions other than the program's
   * latest, such as those of an older build. The world refuses a snapshot
   * that holds a component the program doesn't define, or one whose fields
   * differ from when the snapshot was taken.
   *
   * A snapshot it can't load throws a `SnapshotError`, whose `problem` says
   * why: see `SnapshotProblem`. The world checks each count against the bytes
   * left before it allocates anything for it. A world whose load failed
   * partway is unusable: load into a new one.
   */
  load(bytes: Uint8Array, components: readonly ComponentDef[] = []): void {
    if (
      this.nextIndex !== 0 ||
      this.tables.length > 0 ||
      this._recording ||
      this.singles.some((single) => single?.written === true) ||
      this.stores.some((store) => store.contents() !== undefined)
    ) {
      throw new SnapshotError(
        "world not empty",
        "World.load() fills an empty world, and this one has held entities, has written a singleton or has a store that holds something. Load into a new World."
      );
    }
    for (const def of components) {
      this.register(def);
    }
    this.loading(bytes, true);
  }

  /**
   * `load`, into a world known to be empty: where the format's reader puts
   * each part of a snapshot, and what the world checks of it. The reader
   * knows how a snapshot is laid out, in every version of the format; this
   * knows what a world can hold.
   */
  private loading(bytes: Uint8Array, withStores: boolean): void {
    let slots = 0;
    let freed = 0;
    // The slots whose generations are used up: neither free nor anyone's.
    let retired = 0;
    let isFree = new Uint8Array(0);
    const loaded = new Set<Single>();
    let stored: (readonly [Store, unknown])[] = [];
    read<ComponentDef>(bytes, {
      random: this.random.state,
      slots: (count) => {
        if (count > INDEX_MASK + 1) {
          throw corrupt("it holds more entity slots than a world can have");
        }
        while (this.recTable.length < count) {
          this.growRecords();
        }
        slots = count;
        return this.gens;
      },
      freed: (indexes) => {
        const { gens } = this;
        for (let index = 0; index < slots; index++) {
          if (gens[index]! > GENERATIONS) {
            throw corrupt("a slot has a generation no entity could have");
          }
          if (gens[index] === GENERATIONS) {
            retired++;
          }
        }
        // Every slot is taken to be free until a table claims it.
        isFree = new Uint8Array(slots);
        for (const index of indexes) {
          if (
            index >= slots ||
            isFree[index] === 1 ||
            gens[index] === GENERATIONS
          ) {
            throw corrupt(
              "its list of freed slots names a slot twice, one that does not exist, or one that is used up"
            );
          }
          isFree[index] = 1;
          this.freeList.push(index);
        }
        freed = indexes.length;
        this.nextIndex = slots;
      },
      // Checked against the one this program defines.
      component: (name, storage, fields, kinds) => {
        const def = this.componentsByName.get(name) ?? definedComponent(name);
        if (def === undefined) {
          throw new SnapshotError(
            "unknown component",
            `The snapshot holds a component named "${name}", which this program doesn't define: it was renamed or removed since.`,
            name
          );
        }
        // Field by field, and the two said in words only when they differ:
        // text made here for every component had the load of a snapshot
        // thrown back to the interpreter every time.
        let same =
          storage === storageOf(def) && fields.length === def.fields.length;
        for (let f = 0; same && f < fields.length; f++) {
          same = fields[f] === def.fields[f] && kinds[f] === def.kinds[f];
        }
        if (!same) {
          const was = fields
            .map((field, f) => `${field}: ${kinds[f]}`)
            .join(", ");
          const is = def.fields
            .map((field, f) => `${field}: ${def.kinds[f]}`)
            .join(", ");
          throw new SnapshotError(
            "component changed",
            `"${name}" is not what it was when the snapshot was taken. Then: ${STORAGES[storage] ?? "unknown"} { ${was} }. Now: ${STORAGES[storageOf(def)]} { ${is} }.`,
            name
          );
        }
        this.register(def);
        return def;
      },
      singleton: (def) => {
        if (!def.single) {
          throw corrupt("a singleton is of a component that is not one");
        }
        const single = this.single(def);
        if (loaded.has(single)) {
          throw corrupt("it holds two values for one singleton");
        }
        loaded.add(single);
        single.written = true;
        single.version = this.version.now;
        return single.columns;
      },
      stores: (held) => {
        stored = this.storesOf(held);
      },
      table: (defs, count) => {
        for (const [d, def] of defs.entries()) {
          if (
            def.storage !== "table" ||
            def.single ||
            defs.indexOf(def) !== d
          ) {
            throw corrupt(
              "a table lists a component twice, or one that no table holds"
            );
          }
        }
        const sorted = defs.toSorted((a, b) => a.id - b.id);
        const node = nodeOf(this.tableRoot, sorted);
        if (node.table !== undefined) {
          throw corrupt("it holds two tables for the same components");
        }
        let capacity = 16;
        while (capacity < count) {
          capacity *= 2;
        }
        const table = new Table(
          this.tables.length,
          sorted,
          this.version,
          capacity
        );
        this.tables.push(table);
        node.table = table;
        return {
          entities: table.entities,
          placed: () => {
            this.claimRows(table, count, slots, isFree);
          },
          columns: (def) => table.columns[def.id]!,
        };
      },
      tabled: () => {
        if (this.alive + freed + retired !== slots) {
          throw corrupt("some entity slots are neither in a table nor free");
        }
      },
      sparse: (def, count) => {
        if (def.storage !== "sparse" || def.single) {
          throw corrupt("a sparse set is of a component that is not sparse");
        }
        const set = this._sparse(def);
        if (set.count > 0) {
          throw corrupt("it holds two sparse sets for one component");
        }
        const members = new Uint32Array(count);
        return {
          members,
          placed: () => {
            for (let i = 0; i < count; i++) {
              const index = members[i]!;
              if (
                index >= slots ||
                this.recTable[index]! < 0 ||
                set.has(index)
              ) {
                throw corrupt(
                  "a sparse component is on an entity that does not exist, or on one twice"
                );
              }
              set.add(index, undefined);
            }
          },
          // Not before its members are in: adding them makes it room.
          columns: () => set.columns,
        };
      },
      end() {},
    });
    this.indexRelations();
    // Last, so that a store finds the world it is of as the snapshot has it.
    if (withStores) {
      for (const [store, data] of stored) {
        store.load(data);
      }
    }
  }

  /**
   * Gives the rows of a table that was just read to the entities in them,
   * each checked to be one no other row has and no free slot is.
   */
  private claimRows(
    table: Table,
    count: number,
    slots: number,
    isFree: Uint8Array
  ): void {
    const { gens, recRow, recTable } = this;
    const { entities } = table;
    table.count = count;
    for (let row = 0; row < count; row++) {
      const entity = entityOf(entities[row]!);
      const index = entityIndex(entity);
      // Eight bytes can hold what is no id at all: a number that is not
      // whole, below nothing, or past the last id. None of those is its
      // index and a generation a slot could have; and a slot whose
      // generations are used up, which the count of slots takes for
      // nobody's, is one too many if it holds an entity.
      if (
        index >= slots ||
        isFree[index] === 1 ||
        recTable[index] !== FREE ||
        gens[index] !== (idOf(entity) - index) / SLOTS
      ) {
        throw corrupt(
          "an entity is in two places, or in a slot that is free or of another generation"
        );
      }
      recTable[index] = table.index;
      recRow[index] = row;
    }
    this.alive += count;
  }

  /** Finds the store that each entry of a snapshot's list is of, by its name. */
  private storesOf(
    held: readonly SnapshotStore[]
  ): (readonly [Store, unknown])[] {
    const stored: (readonly [Store, unknown])[] = [];
    let last = "";
    for (const [s, { data, name }] of held.entries()) {
      if (s > 0 && name <= last) {
        throw corrupt(
          "its stores are not in order of name, or one is there twice"
        );
      }
      last = name;
      const store = this.stores.find((one) => one.name === name);
      if (store === undefined) {
        throw new SnapshotError(
          "unknown store",
          `The snapshot holds what a store named "${name}" kept, and this world has no such store: the program that made it kept more of a game in its world than this one does.`
        );
      }
      stored.push([store, data]);
    }
    return stored;
  }

  /** The sparse sets in order of component name. */
  private sparseSetsByName(): SparseSet[] {
    return (this.sparseByName ??= this.sparseList.toSorted((a, b) =>
      byName(a.def, b.def)
    ));
  }

  // --- hash ----------------------------------------------------------------

  /**
   * Returns a single number, from 0 to 2^32 - 1, for everything in the world
   * that a simulation can observe:
   *
   * - every entity, and the value of every field of every component it has,
   *   with each component identified by its name
   * - the order queries visit entities in: tables in the order they were
   *   created, and the rows of each table in order
   * - the ids the next entities will get
   * - every singleton that has been written, by name
   * - the state of the random number generator
   * - what each store attached to the world says a simulation can tell apart
   *   of what it holds. In an app's world, that is the actions queued for the
   *   next tick and the events the simulation has yet to read, and not how far
   *   anyone has read.
   *
   * Two worlds built by the same operations in the same order hash equal, on
   * any machine. Changing one field of one entity always changes the hash. Two
   * different worlds collide by chance about once in four billion.
   *
   * It doesn't depend on anything a simulation can't observe: a table's
   * capacity, leftover data past a column's last row, which queries were
   * created, the order a sparse component's members joined in, or the order
   * components were defined in. Every NaN counts as the same NaN, since its
   * bits are the one thing engines don't agree on. 0 and -0 differ. A `json`
   * field counts as the plain data it holds, a `ref` field as its codec's
   * encoding of each value, and a `transient` field not at all, so the hash
   * covers exactly what a snapshot saves.
   *
   * It hashes again only what changed since the last hash: a component's
   * columns in a table where a loop or `set` was handed them to write, or a
   * row was added or removed, and a sparse component that changed at all.
   * The rest costs one step per component of each table. Hashing a column
   * again costs about 1.4 ns per 32-bit field per entity, measured, with an
   * entity's id counting as two fields when rows were added or removed: 0.4
   * ms for 100,000 entities whose four float fields were all written. A field
   * of a sparse component costs about four times as much.
   */
  hash(): number {
    return this.hashing(true, undefined, false);
  }

  /**
   * @internal
   * `hash()` worked out from every column again, with no cached part: what
   * a write the world did not see, through a cast, would make differ.
   */
  _fullHash(): number {
    return this.hashing(true, undefined, true);
  }

  /**
   * @internal
   * `hash()` without the stores the stages between ticks may change: what
   * those stages must leave as it was. Without the singleton `clock` too, it
   * is what a tick that changed nothing but its time leaves as it was.
   */
  _frameHash(full: boolean, clock?: ComponentDef): number {
    return this.hashing(false, clock, full);
  }

  private hashing(
    betweenTicks: boolean,
    clock: ComponentDef | undefined,
    full: boolean
  ): number {
    // A write from here on is later than what is cached.
    const at = full ? this.version.now : this.version.now++;
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
    // Each column is hashed on its own and folded in as one word, so a
    // column that did not change since the last hash is not hashed again.
    const { tables } = this;
    h = add(h, tables.length);
    for (let t = 0; t < tables.length; t++) {
      const table = tables[t]!;
      const { count, defsByName } = table;
      h = add(add(h, defsByName.length), count);
      // An entity's id carries its generation.
      if (full || table.shaped > table.entitiesHashedAt) {
        const sub = finish(addColumn(0, "entity", table.entities, count));
        if (!full) {
          table.entitiesHash = sub;
          table.entitiesHashedAt = at;
        }
        h = add(h, sub);
      } else {
        h = add(h, table.entitiesHash);
      }
      for (let d = 0; d < defsByName.length; d++) {
        const def = defsByName[d]!;
        const id = def.id;
        h = add(h, shapes[id]!);
        if (full || table.changedAt(id) > table.hashedAt[id]!) {
          const sub = rowsHash(def, table.columns[id]!, count);
          if (!full) {
            table.hashes[id] = sub;
            table.hashedAt[id] = at;
          }
          h = add(h, sub);
        } else {
          h = add(h, table.hashes[id]!);
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
      const shape = shapes[def.id]!;
      if (!full && set.changed <= set.hashedAt) {
        h = add(add(add(h, shape), count), set.hash);
        continue;
      }
      if (this.memberStates.length < count) {
        this.memberStates = new Int32Array(
          Math.max(count, this.memberStates.length * 2)
        );
      }
      const states = this.memberStates;
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
      if (!full) {
        set.hash = members;
        set.hashedAt = at;
      }
      h = add(add(add(h, shape), count), members);
    }

    // Singletons that have been written, in order of name. One that has
    // only been read holds its initial value, which no simulation can tell
    // from its not being there.
    if (this.singles.length > 0) {
      for (const single of this.writtenSingles()) {
        const { columns, def } = single;
        if (def === clock) {
          continue;
        }
        h = add(add(h, SINGLETON), shapes[def.id]!);
        if (full || single.version > single.hashedAt) {
          const sub = rowsHash(def, columns, 1);
          if (!full) {
            single.hash = sub;
            single.hashedAt = at;
          }
          h = add(h, sub);
        } else {
          h = add(h, single.hash);
        }
      }
    }

    const random = this.random.state;
    h = add(add(add(add(h, random[0]!), random[1]!), random[2]!), random[3]!);

    // The stores that hold anything, so that a world whose stores are all
    // empty hashes as one that has none.
    let held = 0;
    for (const store of this.stores) {
      if (!betweenTicks && store.betweenTicks) {
        continue;
      }
      const data = store.hashed();
      if (data !== undefined) {
        h = addData(addString(h, store.name), data);
        held++;
      }
    }
    if (held > 0) {
      h = add(h, held);
    }
    return finish(h);
  }

  // --- stores --------------------------------------------------------------

  /**
   * @internal
   * Attaches a store: state the world holds for its owner beside its
   * components. From then on `snapshot`, `load`, `restore` and `hash` cover
   * it, `_capture` and `_rewind` take it along, and a transaction's rollback
   * takes back what was done to it. Two stores can't share a name. Before
   * the world loads a snapshot that holds anything of it.
   */
  _attach(store: Store): void {
    if (this._recording) {
      throw new Error(
        `The store "${store.name}" was attached in a transaction. Attach a store when its world is made.`
      );
    }
    if (this.stores.some((one) => one.name === store.name)) {
      throw new Error(
        `Two stores are both named "${store.name}". A store's name identifies it in a world and in a snapshot.`
      );
    }
    this.stores = [...this.stores, store].toSorted(byName);
  }

  /**
   * @internal
   * The world as it is, in memory: copies of what `snapshot()` would save of
   * it, sharing with the last moment those that did not change since, and
   * what each store captures of itself, so that capturing puts nothing
   * through a codec. Fails as `snapshot()` does.
   */
  _capture(): Moment {
    this.refuseUnplaced();
    // A write from here on is later than the moment, even if it fails.
    const at = this.version.now++;
    const { freeList, gens } = this;
    const freedGens = new Uint32Array(freeList.length);
    for (let i = 0; i < freeList.length; i++) {
      freedGens[i] = gens[freeList[i]!]!;
    }
    const moment: Moment = {
      at,
      tables: this.tables.map((table) => table.keep(at)),
      sets: this.sparseList.map((set) => set.keep(at)),
      singles: this.writtenSingles().map(
        (single) => [single, keptRow(single)] as const
      ),
      slots: this.nextIndex,
      alive: this.alive,
      freed: freeList.slice(),
      freedGens,
      random: this.random.state.slice(),
      stores: this.stores.map((store) => [store, store.capture()] as const),
      trail: this.follow(),
    };
    this.moments.add(moment);
    return moment;
  }

  /**
   * @internal
   * Whether a moment still holds the trail. Once none does, no rewind can ask
   * for what the logs keep for one: they keep nothing more, and a log of
   * removals that only the trail read is dropped.
   */
  _keeping(): boolean {
    if (this.trail === undefined) {
      return false;
    }
    if (this.trail.deref() !== undefined || this._recording) {
      return true;
    }
    this.trail = undefined;
    this.trails++;
    const logs = this.logs.filter(
      (log) => log.kind !== "removed" || log.cursors.length > 0
    );
    for (const log of this.logs) {
      log.kept = undefined;
      if (!logs.includes(log)) {
        this.removedLogs[log.def.id] = undefined;
      }
    }
    this.logs.splice(0, this.logs.length, ...logs);
    for (const log of logs) {
      log.moved();
    }
    return false;
  }

  /**
   * Puts what the logs hold since the last capture on the trail, and starts
   * the trail anew for the moment being captured.
   */
  private follow(): Trail {
    const last = this._keeping() ? this.trail?.deref() : undefined;
    if (last === undefined) {
      for (const log of this.logs.filter((one) => one.kind !== "removed")) {
        this._log(log.def, "removed");
      }
    }
    for (const log of this.logs) {
      const { kept } = log;
      if (last !== undefined && kept !== undefined && log.waiting(kept) > 0) {
        last.changes.push({
          def: log.def,
          kind: log.kind,
          entries: log.since(kept),
        });
      }
      log.captured();
    }
    const next: Trail = {
      run: this.trails,
      watched: new Set(this.logs.map((log) => logKey(log.def, log.kind))),
      changes: [],
      next: undefined,
      dead: false,
    };
    if (last !== undefined) {
      last.next = next;
    }
    this.trail = new WeakRef(next);
    return next;
  }

  /**
   * @internal
   * Puts the world back to a moment it captured, copying back only what
   * changed since, with what each store held then, and what `changes`, which
   * `saveChanges` returned then, says the readers had yet to visit. A store
   * attached since is left empty. Views made before throw when used, as
   * after `restore`.
   *
   * A reader that `again` accepts, which `changes` doesn't hold, goes on to
   * visit what changed since it last visited and since the moment, in the
   * future given up: with what the ticks run again change, that is all that
   * can be other than it saw. Others start over.
   */
  _rewind(
    moment: Moment,
    changes: readonly SavedChanges[],
    again?: (reader: string) => boolean
  ): void {
    if (!this.moments.has(moment)) {
      throw new Error(
        "World._rewind() was given a moment that this world did not capture."
      );
    }
    const { trail } = moment;
    const onTrail = !trail.dead && trail.run === this.trails;
    const given = onTrail ? this.givenUp(trail, again) : [];
    this.putBack(moment);
    for (const [store, held] of moment.stores) {
      store.rewind(held);
    }
    if (!onTrail) {
      this.trails++;
    }
    this.trail = onTrail ? new WeakRef(trail) : undefined;
    this.restoreChanges(ahead(given, changes, this._slots));
  }

  /**
   * Puts the world back to a moment, touching only what changed since: the
   * tables are the moment's again, those made since are gone, and a column
   * that was not written since is not copied.
   */
  private putBack(moment: Moment): void {
    this.refuseRestore();
    const { at } = moment;
    const { gens, recRow, recTable, tables } = this;

    // The slots that were free then, and those not used yet, are free.
    for (let i = 0; i < moment.freed.length; i++) {
      const index = moment.freed[i]!;
      recTable[index] = FREE;
      gens[index] = moment.freedGens[i]!;
    }
    for (let index = moment.slots; index < this.nextIndex; index++) {
      recTable[index] = FREE;
      recRow[index] = 0;
      gens[index] = 0;
    }
    const { freeList } = this;
    freeList.length = moment.freed.length;
    for (let i = 0; i < moment.freed.length; i++) {
      freeList[i] = moment.freed[i]!;
    }
    this.nextIndex = moment.slots;
    this.alive = moment.alive;

    // Tables are only ever added, so the moment's are the first of today's,
    // unless a rewind cut them since: from the first that is not, the
    // moment's take their place, and those made since are gone.
    let cut = 0;
    while (
      cut < moment.tables.length &&
      cut < tables.length &&
      tables[cut] === moment.tables[cut]!.table
    ) {
      cut++;
    }
    if (cut < tables.length) {
      for (let t = cut; t < tables.length; t++) {
        nodeOf(this.tableRoot, tables[t]!.defs).table = undefined;
      }
      tables.length = cut;
      for (const table of tables) {
        for (const edges of [table.addEdges, table.removeEdges]) {
          for (const [id, to] of edges) {
            if (to.index >= cut) {
              edges.delete(id);
            }
          }
        }
      }
    }
    for (let t = 0; t < moment.tables.length; t++) {
      const kept = moment.tables[t]!;
      const { table } = kept;
      const back = t >= cut;
      if (back) {
        tables.push(table);
        nodeOf(this.tableRoot, table.defs).table = table;
        table.addEdges.clear();
        table.removeEdges.clear();
      }
      // A table whose rows did not move holds the same entities where they were.
      const moved = back || table.shaped > at;
      table.putBack(kept, back ? -1 : at);
      if (!moved) {
        continue;
      }
      const { entities } = table;
      for (let row = 0; row < table.count; row++) {
        const id = entities[row]!;
        const index = id & INDEX_MASK;
        recTable[index] = t;
        recRow[index] = row;
        gens[index] = (id - index) / SLOTS;
      }
    }

    // Sparse sets are never taken away: one made since is emptied.
    const keptSets = new Map(
      moment.sets.map((kept) => [kept.set.def.id, kept])
    );
    const sets: SparseSet[] = moment.sets.map((kept) => kept.set);
    for (const set of this.sparseList) {
      const kept = keptSets.get(set.def.id);
      if (kept === undefined) {
        sets.push(set);
        set.putBack(undefined);
      }
    }
    for (const kept of moment.sets) {
      const { set } = kept;
      if (this.sparseById.get(set.def.id) !== set || set.changed > at) {
        set.putBack(kept);
      }
      this.sparseById.set(set.def.id, set);
    }
    this.sparseList.splice(0, this.sparseList.length, ...sets);
    this.sparseByName = undefined;

    // Who points at whom, worked out again where a link changed.
    for (const def of this.componentsByName.values()) {
      if (def.relation === undefined) {
        continue;
      }
      const relation = this.relations[def.id];
      if (relation === undefined || relation.changed > at) {
        relation?.clear();
        this.relink(def);
      }
    }

    // The singletons it held have their values, a `transient` field its
    // initial value where the singleton was written since, and the others
    // are as if never written.
    const held = new Set<Single>();
    for (const [single, row] of moment.singles) {
      held.add(single);
      if (single.written && single.version <= at) {
        continue;
      }
      writeRow(single.def, single.columns, 0, { ...single.initial, ...row });
      single.written = true;
      single.version = this.version.now;
    }
    for (const single of this.singles) {
      if (single !== undefined && single.written && !held.has(single)) {
        single.written = false;
        single.version = this.version.now;
        writeRow(single.def, single.columns, 0, single.initial);
      }
    }
    this.random.state.set(moment.random);
    for (const store of this.stores) {
      store.clear();
    }
    this.dropViews();
    this.version.now++;
  }

  /**
   * For each log there was at `from`, what the readers `again` accepts are to
   * visit after a rewind to it: what they had yet to visit, and what the
   * future given up changed, gave or took away. Gives up the trail after
   * `from`, which is that future's.
   */
  private givenUp(
    from: Trail,
    again: ((reader: string) => boolean) | undefined
  ): SavedChanges[] {
    const touched = new Map<number, number[]>();
    const touch = (
      def: ComponentDef,
      kind: ChangeKind,
      entries: Uint32Array | Float64Array
    ): void => {
      const key = logKey(def, kind);
      let indexes = touched.get(key);
      if (indexes === undefined) {
        indexes = [];
        touched.set(key, indexes);
      }
      for (let i = 0; i < entries.length; i++) {
        indexes.push(entries[i]! & INDEX_MASK);
      }
    };
    for (let node: Trail | undefined = from; node !== undefined;) {
      for (const { def, kind, entries } of node.changes) {
        touch(def, kind, entries);
      }
      const next: Trail | undefined = node.next;
      if (node !== from) {
        node.dead = true;
      }
      node = next;
    }
    from.changes = [];
    from.next = undefined;
    for (const log of this.logs) {
      touch(log.def, log.kind, log.since(log.kept ?? log.end));
    }
    const out: SavedChanges[] = [];
    for (const log of this.logs) {
      const { def, kind } = log;
      if (kind === "removed" || !from.watched.has(logKey(def, kind))) {
        continue;
      }
      const readers = log.cursors.filter(
        (cursor) => !cursor.fresh && again?.(cursor.reader) === true
      );
      const entries = new Set<number>();
      if (readers.length > 0) {
        const at = Math.min(...readers.map((cursor) => cursor.at));
        for (const indexes of [
          log.since(at),
          touched.get(logKey(def, kind)) ?? [],
          touched.get(logKey(def, "removed")) ?? [],
        ]) {
          for (const index of indexes) {
            entries.add(index);
          }
        }
      }
      out.push({
        component: def.name,
        kind,
        entries: [...entries],
        readers: Object.fromEntries(readers.map((cursor) => [cursor.key, 0])),
      });
    }
    return out;
  }

  // --- internals -----------------------------------------------------------

  /** @internal */
  _sparse(def: ComponentDef): SparseSet {
    let set = this.sparseById.get(def.id);
    if (set === undefined) {
      this.refuseSingle(def);
      this.register(def);
      set = new SparseSet(def, this.version);
      this.sparseById.set(def.id, set);
      this.sparseList.push(set);
      this.sparseByName = undefined;
    }
    return set;
  }

  private tableFor(sortedDefs: readonly ComponentDef[]): Table {
    const node = nodeOf(this.tableRoot, sortedDefs);
    let { table } = node;
    if (table === undefined) {
      for (const def of sortedDefs) {
        this.refuseSingle(def);
        this.register(def);
      }
      table = new Table(this.tables.length, sortedDefs, this.version);
      this.tables.push(table);
      node.table = table;
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
