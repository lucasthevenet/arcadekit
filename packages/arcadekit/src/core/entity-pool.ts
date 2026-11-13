/**
 * Entity pools: a fixed number of entities stored as one typed array per field, with the live
 * ones packed at the front.
 *
 * A step keeps its crowds in entity pools (enemies, projectiles, gems), so moving thousands of
 * them reads and writes numbers and allocates nothing after the pool is made. Removing an entity
 * swaps the last one into its slot, so an index is not stable: an identified pool also gives
 * each entity an id that stays with it.
 *
 * @since 0.7.0
 */
import type { Types } from "effect";
import { Inspectable, Pipeable, Predicate } from "effect";
import { dual } from "effect/Function";

import { allocate, arraysOf } from "./internal/fields";
import type { FieldArray } from "./internal/fields";
import type * as Layout from "./layout";

const TypeId = "~arcadekit/core/EntityPool";

const IdentifiedTypeId = "~arcadekit/core/EntityPool/Identified";

/**
 * A fixed-capacity set of entities stored as "structure of arrays": one typed array per field of
 * its layout, with the live entities packed into the indices `[0, count)`.
 *
 * **When to use**
 *
 * Keep a step's many entities of one kind in one: what a step moves, hits and removes every
 * frame, read by index in a `for` loop.
 *
 * **Details**
 *
 * Nothing is allocated after the pool is made, so a step that adds and removes entities never
 * makes garbage. `add` reserves the next slot with every field 0, and `remove` moves the last
 * entity into the removed one's slot: remove while walking backwards, or don't advance the index
 * after a removal. `count` and `fields` are read directly; only the module's functions change
 * `count`.
 *
 * **Example** (Spawning and removing entities)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 *
 * const enemies = EntityPool.make(3, { x: Float32Array, hp: Float32Array });
 * for (const x of [1, 2, 3]) {
 *   const i = EntityPool.add(enemies);
 *   enemies.fields.x[i] = x;
 *   enemies.fields.hp[i] = 10;
 * }
 * EntityPool.add(enemies); // => -1
 *
 * EntityPool.remove(enemies, 0);
 * enemies.count; // => 2
 * enemies.fields.x[0]; // => 3
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface EntityPool<L extends Layout.Layout>
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** The most entities it holds, and the length of every field. */
  readonly capacity: number;
  /** The live entities, at indices `[0, count)`. */
  readonly count: number;
  /** One typed array per field of the layout, under the layout's names. */
  readonly fields: Layout.Fields<L>;
}

/**
 * An entity pool whose entities also have stable ids, for a game that must name one entity
 * across removals: an undo, a view that tweens each entity, a target to follow.
 *
 * **When to use**
 *
 * Make one with `makeIdentified` when something outside the step's loop keeps a reference to an
 * entity. An index moves when another entity is removed; an id doesn't.
 *
 * **Details**
 *
 * Ids are in `[0, capacity)`. `add` hands out a free id, 0, 1, 2… in order; a removed entity's
 * id is free again and a later `add` may hand it out, so don't keep an id past its entity's
 * removal unless `addWithId` brings it back. Every function of an identified pool is O(1) and
 * allocates nothing, and every function of an entity pool takes one.
 *
 * **Example** (Following an entity by its id)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 *
 * const boxes = EntityPool.makeIdentified(4, { cell: Int32Array });
 * for (const cell of [10, 20, 30]) {
 *   boxes.fields.cell[EntityPool.add(boxes)] = cell;
 * }
 * EntityPool.remove(boxes, 0);
 *
 * const i = EntityPool.indexOf(boxes, 2);
 * i; // => 0
 * boxes.fields.cell[i]; // => 30
 * EntityPool.indexOf(boxes, 0); // => -1
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Identified<L extends Layout.Layout> extends EntityPool<L> {
  readonly [IdentifiedTypeId]: typeof IdentifiedTypeId;
}

/** What the module's functions write, beyond what a caller reads. */
type Internal<L extends Layout.Layout> = Types.Mutable<EntityPool<L>> & {
  arrays: readonly FieldArray[];
};

/**
 * An identified pool's ids, as a sparse set: `idAt[0, count)` are the live entities' ids in
 * index order, `idAt[count, capacity)` the free ids, and `indexOfId` is its inverse.
 */
type IdentifiedInternal<L extends Layout.Layout> = Types.Mutable<
  Identified<L>
> &
  Ids & { arrays: readonly FieldArray[] };

/** What `resetIds` and `swapIds` work on. */
interface Ids {
  capacity: number;
  idAt: Int32Array;
  indexOfId: Int32Array;
}

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: EntityPool<Layout.Layout>) {
    return {
      _id: "EntityPool",
      capacity: this.capacity,
      count: this.count,
      fields: Object.keys(this.fields),
    };
  },
};

const IdentifiedProto = {
  ...Proto,
  [IdentifiedTypeId]: IdentifiedTypeId,
  toJSON(this: EntityPool<Layout.Layout>) {
    return {
      _id: "EntityPool.Identified",
      capacity: this.capacity,
      count: this.count,
      fields: Object.keys(this.fields),
    };
  },
};

const fill = <L extends Layout.Layout>(
  self: Internal<L> | IdentifiedInternal<L>,
  capacity: number,
  layout: L
): void => {
  self.capacity = capacity;
  self.count = 0;
  self.fields = allocate(layout, capacity);
  self.arrays = arraysOf(self.fields);
};

/** Frees every id, each at its own position: `add` then hands out 0, 1, 2… */
const resetIds = (self: Ids): void => {
  for (let i = 0; i < self.capacity; i++) {
    self.idAt[i] = i;
    self.indexOfId[i] = i;
  }
};

/** Swaps the ids at positions `a` and `b`. */
const swapIds = (self: Ids, a: number, b: number): void => {
  const idA = self.idAt[a]!;
  const idB = self.idAt[b]!;
  self.idAt[a] = idB;
  self.idAt[b] = idA;
  self.indexOfId[idB] = a;
  self.indexOfId[idA] = b;
};

/**
 * Checks whether a value is an entity pool, identified or not.
 *
 * **When to use**
 *
 * Narrow an unknown value before reading it as a pool, such as in a debugging tool that walks a
 * state.
 *
 * **Details**
 *
 * It looks for the pool's marker, and checks nothing of its layout.
 *
 * **Example** (Recognising a pool)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 *
 * EntityPool.isEntityPool(EntityPool.make(4, { x: Float32Array })); // => true
 * EntityPool.isEntityPool({ count: 0, fields: {} }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isEntityPool = (
  value: unknown
): value is EntityPool<Layout.Layout> => Predicate.hasProperty(value, TypeId);

/**
 * Checks whether a value is an identified pool.
 *
 * **When to use**
 *
 * Tell an identified pool from a plain one before reading an entity's id.
 *
 * **Example** (Telling the two kinds apart)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 *
 * EntityPool.isIdentified(EntityPool.makeIdentified(4, { x: Float32Array })); // => true
 * EntityPool.isIdentified(EntityPool.make(4, { x: Float32Array })); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isIdentified = (
  value: unknown
): value is Identified<Layout.Layout> =>
  Predicate.hasProperty(value, IdentifiedTypeId);

/**
 * Makes an entity pool of `capacity` entities, with one typed array of that length for each
 * field of `layout`.
 *
 * **When to use**
 *
 * Make each of a run's pools once, when the run's state is made, with the most entities of its
 * kind the run can have.
 *
 * **Details**
 *
 * The pool starts empty. Every array is made here and never again, so nothing a step does to the
 * pool allocates.
 *
 * **Example** (Making a pool)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 *
 * const gems = EntityPool.make(1024, { x: Float32Array, value: Uint16Array });
 * gems.count; // => 0
 * gems.fields.value.length; // => 1024
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = <const L extends Layout.Layout>(
  capacity: number,
  layout: L
): EntityPool<L> => {
  const self = Object.create(Proto) as Internal<L>;
  fill(self, capacity, layout);
  return self;
};

/**
 * Makes an identified pool of `capacity` entities: an entity pool whose entities also have
 * stable ids.
 *
 * **When to use**
 *
 * In place of `make`, for a kind of entity something must name across removals.
 *
 * **Details**
 *
 * It starts empty, with every id free, and `add` hands them out from 0.
 *
 * **Example** (Making an identified pool)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 *
 * const boxes = EntityPool.makeIdentified(8, { cell: Int32Array });
 * EntityPool.idOf(boxes, EntityPool.add(boxes)); // => 0
 * EntityPool.idOf(boxes, EntityPool.add(boxes)); // => 1
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const makeIdentified = <const L extends Layout.Layout>(
  capacity: number,
  layout: L
): Identified<L> => {
  const self = Object.create(IdentifiedProto) as IdentifiedInternal<L>;
  fill(self, capacity, layout);
  self.idAt = new Int32Array(capacity);
  self.indexOfId = new Int32Array(capacity);
  resetIds(self);
  return self;
};

/**
 * Reserves the next slot and returns its index, or -1 when the pool is full. Every field of the
 * slot is 0.
 *
 * **When to use**
 *
 * To spawn an entity: add it, then write the fields it starts with.
 *
 * **Details**
 *
 * The slot is cleaned here, not when an entity leaves it, so it is 0 after a `clear` and on its
 * first use alike. An identified pool's new entity takes the next free id.
 *
 * **Example** (Spawning into a slot)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 *
 * const shots = EntityPool.make(2, { x: Float32Array });
 * const i = EntityPool.add(shots);
 * i; // => 0
 * shots.fields.x[i] = 4;
 * EntityPool.add(shots); // => 1
 * EntityPool.add(shots); // => -1
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const add = <L extends Layout.Layout>(self: EntityPool<L>): number => {
  const pool = self as Internal<L>;
  if (pool.count === pool.capacity) {
    return -1;
  }
  for (const array of pool.arrays) {
    array[pool.count] = 0;
  }
  pool.count += 1;
  return pool.count - 1;
};

/**
 * Removes the entity at `index` by moving the last entity into its slot.
 *
 * **When to use**
 *
 * To despawn an entity in a step's loop: walk the pool from its end, or stay on the same index
 * after a removal, since the last entity is now there.
 *
 * **Details**
 *
 * The last slot keeps what its entity left until `add` hands it out again. An identified pool
 * moves the last entity's id with it, and the removed entity's id is free.
 *
 * **Example** (Despawning while walking backwards)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 *
 * const enemies = EntityPool.make(4, { hp: Float32Array });
 * for (const hp of [5, 0, 7, 0]) {
 *   enemies.fields.hp[EntityPool.add(enemies)] = hp;
 * }
 * for (let i = enemies.count - 1; i >= 0; i--) {
 *   if (enemies.fields.hp[i] === 0) {
 *     EntityPool.remove(enemies, i);
 *   }
 * }
 * enemies.count; // => 2
 * [...enemies.fields.hp.subarray(0, enemies.count)]; // => [5, 7]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const remove: {
  (index: number): <L extends Layout.Layout>(self: EntityPool<L>) => void;
  <L extends Layout.Layout>(self: EntityPool<L>, index: number): void;
} = dual(
  2,
  <L extends Layout.Layout>(self: EntityPool<L>, index: number): void => {
    const pool = self as Internal<L>;
    if (isIdentified(self)) {
      // The last entity's fields move into `index`; its id moves the same way, which leaves the
      // removed id just past the live ones, so it is free.
      swapIds(self as unknown as Ids, index, pool.count - 1);
    }
    pool.count -= 1;
    const last = pool.count;
    if (index !== last) {
      for (const array of pool.arrays) {
        array[index] = array[last]!;
      }
    }
  }
);

/**
 * Removes every entity.
 *
 * **When to use**
 *
 * To empty a pool for a new wave or a new run that keeps the same state.
 *
 * **Details**
 *
 * It only forgets the count: each slot is cleaned as `add` hands it out. An identified pool
 * frees every id, so `add` hands out 0, 1, 2… again.
 *
 * **Example** (Emptying a pool)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 *
 * const pool = EntityPool.makeIdentified(4, { x: Float32Array });
 * EntityPool.add(pool);
 * EntityPool.add(pool);
 * EntityPool.clear(pool);
 * pool.count; // => 0
 * EntityPool.idOf(pool, EntityPool.add(pool)); // => 0
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const clear = <L extends Layout.Layout>(self: EntityPool<L>): void => {
  (self as Internal<L>).count = 0;
  if (isIdentified(self)) {
    resetIds(self as unknown as Ids);
  }
};

/**
 * The id of the entity at `index` in an identified pool.
 *
 * **When to use**
 *
 * To name the entity a step is looking at, so that something outside the loop can find it again
 * after other removals.
 *
 * **Details**
 *
 * `index` is one of the live ones, below `count`: past it is a free id, which no entity has.
 *
 * **Example** (Reading an id)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 *
 * const pool = EntityPool.makeIdentified(4, { x: Float32Array });
 * EntityPool.add(pool);
 * EntityPool.add(pool);
 * EntityPool.remove(pool, 0);
 * EntityPool.idOf(pool, 0); // => 1
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const idOf: {
  (index: number): <L extends Layout.Layout>(self: Identified<L>) => number;
  <L extends Layout.Layout>(self: Identified<L>, index: number): number;
} = dual(
  2,
  <L extends Layout.Layout>(self: Identified<L>, index: number): number =>
    (self as unknown as IdentifiedInternal<L>).idAt[index]!
);

/**
 * The index of the entity with `id` in an identified pool, or -1 if no live entity has it.
 *
 * **When to use**
 *
 * To find an entity again by the id something kept: a view's tween, an undo's record.
 *
 * **Details**
 *
 * An id out of range, or free, gives -1.
 *
 * **Example** (Finding an entity by id)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 *
 * const pool = EntityPool.makeIdentified(4, { x: Float32Array });
 * for (const x of [10, 20, 30]) {
 *   pool.fields.x[EntityPool.add(pool)] = x;
 * }
 * EntityPool.remove(pool, 0);
 * pool.fields.x[EntityPool.indexOf(pool, 2)]; // => 30
 * EntityPool.indexOf(pool, 0); // => -1
 * EntityPool.indexOf(pool, 9); // => -1
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const indexOf: {
  (id: number): <L extends Layout.Layout>(self: Identified<L>) => number;
  <L extends Layout.Layout>(self: Identified<L>, id: number): number;
} = dual(
  2,
  <L extends Layout.Layout>(self: Identified<L>, id: number): number => {
    const pool = self as unknown as IdentifiedInternal<L>;
    return id >= 0 && id < pool.capacity && pool.indexOfId[id]! < pool.count
      ? pool.indexOfId[id]!
      : -1;
  }
);

/**
 * Adds an entity under a chosen free id, such as a removed entity coming back on undo. Returns
 * its index, or -1 when the pool is full or the id is in use or out of range.
 *
 * **When to use**
 *
 * To bring an entity back under the id it had, where `add` would hand out any free one.
 *
 * **Details**
 *
 * Every field of its slot is 0, as after `add`.
 *
 * **Example** (Undoing a removal)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 *
 * const boxes = EntityPool.makeIdentified(4, { cell: Int32Array });
 * for (const cell of [10, 20, 30]) {
 *   boxes.fields.cell[EntityPool.add(boxes)] = cell;
 * }
 * EntityPool.remove(boxes, EntityPool.indexOf(boxes, 1));
 * const i = EntityPool.addWithId(boxes, 1);
 * boxes.fields.cell[i] = 20;
 * EntityPool.indexOf(boxes, 1) === i; // => true
 * EntityPool.addWithId(boxes, 1); // => -1
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const addWithId: {
  (id: number): <L extends Layout.Layout>(self: Identified<L>) => number;
  <L extends Layout.Layout>(self: Identified<L>, id: number): number;
} = dual(
  2,
  <L extends Layout.Layout>(self: Identified<L>, id: number): number => {
    const pool = self as unknown as IdentifiedInternal<L>;
    if (id < 0 || id >= pool.capacity || pool.indexOfId[id]! < pool.count) {
      return -1;
    }
    // The free id moves to position `count`, the one `add` hands out next.
    swapIds(pool, pool.indexOfId[id]!, pool.count);
    return add(self);
  }
);

/**
 * Calls `f` with the pool's `count`, then with each field's live values, one field at a time in
 * the layout's order.
 *
 * **When to use**
 *
 * To fold a pool into a state hash, or into anything that takes its numbers one by one in a
 * fixed order.
 *
 * **Details**
 *
 * It allocates nothing. A field named by a whole number (`{ 0: Uint8Array }`) is the exception
 * to the layout's order: such fields come first, in ascending order, as an object's keys do. An
 * identified pool's ids are not visited: they follow from the order of its adds and removes.
 *
 * **Example** (Visiting a pool's numbers)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 *
 * const pool = EntityPool.make(4, { x: Float32Array, hp: Uint8Array });
 * for (const x of [1, 2]) {
 *   const i = EntityPool.add(pool);
 *   pool.fields.x[i] = x;
 *   pool.fields.hp[i] = x * 10;
 * }
 * const seen: number[] = [];
 * EntityPool.visit(pool, (value) => seen.push(value));
 * seen; // => [2, 1, 2, 10, 20]
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const visit: {
  (
    f: (value: number) => void
  ): <L extends Layout.Layout>(self: EntityPool<L>) => void;
  <L extends Layout.Layout>(
    self: EntityPool<L>,
    f: (value: number) => void
  ): void;
} = dual(
  2,
  <L extends Layout.Layout>(
    self: EntityPool<L>,
    f: (value: number) => void
  ): void => {
    f(self.count);
    const { fields } = self;
    // The fields `Object.values` would list, in its order, without the array it would make on
    // every call.
    for (const name in fields) {
      if (Object.hasOwn(fields, name)) {
        const array = fields[name];
        for (let i = 0; i < self.count; i++) {
          f(array[i]!);
        }
      }
    }
  }
);
