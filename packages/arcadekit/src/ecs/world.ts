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
import { ChangeLog, RemovedReader } from "./changes";
import type { ChangeCursor, ChangeKind, SavedChanges } from "./changes";
import type { Column } from "./column";
import {
  GENERATIONS,
  INDEX_MASK,
  definedComponent,
  entityIndex,
  frozenWrite,
  isBoxed,
  isComponentDef,
  makeEntity,
  refuseRetarget,
  targetless,
} from "./component";
import type {
  ComponentDef,
  ComponentInput,
  ComponentValue,
  Entity,
  Schema,
  SingletonSpec,
  ValueOf,
} from "./component";
import { read, write } from "./format";
import type { SnapshotStore } from "./format";
import {
  add,
  addColumn,
  addColumnPerRow,
  addData,
  addString,
  finish,
  shapeOf,
} from "./hash";
import { QueryView, describeSpec } from "./query";
import type { QuerySpec, Terms } from "./query";
import { Rng } from "./random";
import { NOT_PLACED, WHOLE } from "./records";
import type { Saved, Single } from "./records";
import type { PatchOf, RelationDef, Targeted } from "./relation";
import { STORAGES, SnapshotError, WIDTH, corrupt } from "./snapshot";
import type { Store } from "./store";
import type { Columns } from "./table";
import {
  RelationIndex,
  SparseSet,
  Table,
  byName,
  makeColumns,
  readRow,
  tableKey,
  writeRow,
} from "./table";

const FREE = -2;
/** The number of slots: what an id's generation is multiplied by. */
const SLOTS = INDEX_MASK + 1;
/** What `hash` folds in before each singleton, to distinguish it from a sparse set. */
const SINGLETON = 0x53_49_4e_47;
const storageOf = (def: ComponentDef): 0 | 1 | 2 =>
  def.single ? 2 : def.storage === "sparse" ? 1 : 0;

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/**
 * @internal
 * A world at one moment, held in memory: what `_capture` returns and `_rewind`
 * takes.
 */
export interface Moment {
  /** A snapshot without the stores. */
  readonly world: Uint8Array;
  /** What each store captured of itself. */
  readonly stores: readonly (readonly [Store, unknown])[];
}

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
  /** What its owner attached, in order of name. */
  /** What was attached, in order of name: `_attach`. */
  private stores: readonly Store[] = [];
  /** The moments this world captured: `_rewind` takes no other. */
  private readonly moments = new WeakSet<Moment>();
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
   * Copies what the world holds, as plain objects: every live entity, in
   * order of index, with each of its components by name, every singleton
   * the world holds, by name, and what each store attached to it holds, by
   * the store's name. It reads every component of every entity, so it is for
   * tooling, and not for a system.
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
   * Writes some or all fields of a component the entity already has. A
   * relation's `target` is not one of them: add the relation again.
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
  sources(target: Entity, def: RelationDef): Entity[] {
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
   * Whether the world holds a singleton as its own: written since the world
   * began, or loaded. Until then it is its initial value, and is in neither
   * the snapshot nor the hash.
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
    for (const store of this.stores) {
      store.begin();
    }
    this._recording = true;
  }

  /** Ends the transaction and keeps what was written. */
  commit(): void {
    this.endTransaction("commit");
    for (const store of this.stores) {
      store.commit();
    }
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
    for (const store of this.stores) {
      store.rollback();
    }
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

  /**
   * Has `reader` skip what changed: each change query and `removed` reader of
   * its that has visited before moves to the end, so that its next visit sees
   * only what changes from now on. One that has never visited still sees
   * everything that matches. An app calls this for a system that its
   * condition doesn't let run, so that it sees nothing from while it was off.
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
   * singleton that has been written, the upcoming ids, the random generator's
   * state, and what each store attached to the world holds: in an app's world,
   * the actions queued for the next tick and the events waiting to be read. A
   * world with the same stores that loads the bytes hashes the same as this one
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
    return this.snapshotOf(true);
  }

  /** `snapshot()`, with what the stores hold or without it. */
  private snapshotOf(withStores: boolean): Uint8Array {
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
   * Replaces everything in this world with a snapshot: the world is emptied and
   * then loaded, as `load` loads a new one. It is meant for a snapshot this
   * world took itself, or one from an identically built world, since it only
   * knows the components it has encountered.
   *
   * Afterwards, the world holds what a new world that loaded the snapshot
   * would: the same hash, the same iteration order, the same upcoming ids, the
   * same random numbers. A singleton's value stays the same object, holding the
   * snapshot's value, or its initial value if the snapshot doesn't hold it.
   * `world.random` stays the same generator. What each store attached to the
   * world holds is the snapshot's too: in an app's world, the queued actions
   * and the waiting events, with every system's place in them.
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
    this.restoring(bytes, true);
  }

  /** `restore`, with what the snapshot holds of the stores or with each empty. */
  private restoring(bytes: Uint8Array, withStores: boolean): void {
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
    // The singletons stay the objects they are, as if never written, and the
    // stores the ones that were attached, empty.
    for (const single of this.singles) {
      if (single !== undefined) {
        single.written = false;
        writeRow(single.def, single.columns, 0, single.initial);
      }
    }
    for (const store of this.stores) {
      store.clear();
    }
    this.loading(bytes, withStores);
  }

  /**
   * Fills this world from a snapshot. The world must be empty: one that has
   * never held an entity.
   *
   * A snapshot names its components, and each is found by its definition: the
   * one this world has met with that name, or else the one this program
   * defined last with it. `components` are met first, for a tool that reads a
   * snapshot with definitions other than the program's latest, such as those
   * of an older build. A snapshot that holds a component the program doesn't
   * define, or one whose fields differ from when it was taken, is refused.
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
        const key = tableKey(sorted);
        if (this.tableByKey.has(key)) {
          throw corrupt("it holds two tables for the same components");
        }
        let capacity = 16;
        while (capacity < count) {
          capacity *= 2;
        }
        const table = new Table(this.tables.length, sorted, capacity);
        this.tables.push(table);
        this.tableByKey.set(key, table);
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
      const entity = entities[row] as Entity;
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
        gens[index] !== (entity - index) / SLOTS
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
   * Returns a single number, from 0 to 2^32 - 1, for everything in the world a
   * simulation can observe:
   *
   * - every entity and the value of every field of every component it has, with
   *   components identified by name;
   * - the order queries visit entities in (tables in creation order, rows
   *   ascending);
   * - the ids the next entities will get;
   * - every singleton that has been written, by name;
   * - the state of the random number generator;
   * - what each store attached to the world says a simulation can tell apart
   *   of what it holds: in an app's world, the actions queued for the next
   *   tick and the events the simulation has yet to read, but not where anyone
   *   has read to.
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
    return this.hashing(true);
  }

  /**
   * @internal
   * `hash()` without the stores the stages between ticks may change: what
   * those stages must leave as it was. Without the singleton `clock` too, it
   * is what a tick that changed nothing but its time leaves as it was.
   */
  _frameHash(clock?: ComponentDef): number {
    return this.hashing(false, clock);
  }

  private hashing(betweenTicks: boolean, clock?: ComponentDef): number {
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
        if (def === clock) {
          continue;
        }
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
   * The world as it is, in memory: `snapshot()` without the stores, and what
   * each store captures of itself, so that capturing puts nothing of theirs
   * through a codec. Fails as `snapshot()` does.
   */
  _capture(): Moment {
    const moment: Moment = {
      world: this.snapshotOf(false),
      stores: this.stores.map((store) => [store, store.capture()] as const),
    };
    this.moments.add(moment);
    return moment;
  }

  /**
   * @internal
   * Puts the world back to a moment it captured, as `restore` does, with
   * what each store held then. A store attached since is left empty.
   */
  _rewind(moment: Moment): void {
    if (!this.moments.has(moment)) {
      throw new Error(
        "World._rewind() was given a moment that this world did not capture."
      );
    }
    this.restoring(moment.world, false);
    for (const [store, held] of moment.stores) {
      store.rewind(held);
    }
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
    const key = tableKey(sortedDefs);
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
