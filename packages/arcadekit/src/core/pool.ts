type TypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array;

type TypedArrayConstructor = new (length: number) => TypedArray;

/** Field layout of a pool: field name -> typed array constructor, e.g. `{ x: Float32Array, hp: Float32Array }`. */
export type PoolLayout = Record<string, TypedArrayConstructor>;

export type PoolFields<L extends PoolLayout> = {
  readonly [K in keyof L]: InstanceType<L[K]>;
};

/**
 * A fixed-capacity set of entities stored as "structure of arrays": one typed array per field,
 * with live entities packed into indices [0, count).
 *
 * Nothing is allocated after creation, so a game loop using pools never triggers garbage collection.
 * Removing swaps the last entity into the hole, so indices are not stable across removals:
 * remove while iterating backwards, or don't advance the index after a removal.
 */
export interface Pool<L extends PoolLayout> {
  readonly capacity: number;
  readonly count: number;
  readonly fields: PoolFields<L>;
  /** Reserves the next slot and returns its index, or -1 when full. Every field of the slot is 0. */
  readonly add: () => number;
  /** Removes the entity at `index` by moving the last entity into it. */
  readonly remove: (index: number) => void;
  readonly clear: () => void;
}

export const createPool = <const L extends PoolLayout>(
  capacity: number,
  layout: L
): Pool<L> => {
  const fields = Object.fromEntries(
    Object.entries(layout).map(([name, ArrayType]) => [
      name,
      new ArrayType(capacity),
    ])
  ) as unknown as PoolFields<L>;
  const arrays = Object.values(fields) as TypedArray[];
  let count = 0;
  return {
    capacity,
    get count() {
      return count;
    },
    fields,
    add: () => {
      if (count === capacity) {
        return -1;
      }
      // Here and not in `remove`, so a slot is clean after a `clear` and on its first use too.
      for (const array of arrays) {
        array[count] = 0;
      }
      count += 1;
      return count - 1;
    },
    remove: (index) => {
      count -= 1;
      const last = count;
      if (index !== last) {
        for (const array of arrays) {
          array[index] = array[last]!;
        }
      }
    },
    clear: () => {
      count = 0;
    },
  };
};

/**
 * A Pool whose entities also have stable ids, for a genre that must name one entity across
 * removals (undo, a view that tweens each entity, a target to follow). Indices still move on
 * removal; ids don't.
 *
 * Ids are in [0, capacity). `add` hands out a free id, starting with 0, 1, 2… in order. A removed
 * entity's id becomes free and may be handed out again by a later `add`, so don't keep an id
 * past its entity's removal unless you bring it back with `addWithId`.
 * Every operation is O(1) and allocates nothing.
 */
export interface IdentifiedPool<L extends PoolLayout> extends Pool<L> {
  /** Stable id of the entity at `index`. */
  readonly idOf: (index: number) => number;
  /** Index of the entity with `id`, or -1 if no entity in the pool has it. */
  readonly indexOf: (id: number) => number;
  /**
   * Adds an entity under a chosen free id, such as a removed entity coming back on undo.
   * Returns its index, or -1 when the pool is full or the id is in use or out of range.
   * Every field of its slot is 0, as after `add`.
   */
  readonly addWithId: (id: number) => number;
}

export const createIdentifiedPool = <const L extends PoolLayout>(
  capacity: number,
  layout: L
): IdentifiedPool<L> => {
  const pool = createPool(capacity, layout);
  // A sparse set. `idAt[0, count)` are the live entities' ids in index order;
  // `idAt[count, capacity)` are the free ids. `indexOfId` is its inverse.
  const idAt = new Int32Array(capacity);
  const indexOfId = new Int32Array(capacity);
  const reset = () => {
    for (let i = 0; i < capacity; i++) {
      idAt[i] = i;
      indexOfId[i] = i;
    }
  };
  /** Swaps the ids at positions `a` and `b`. */
  const swap = (a: number, b: number) => {
    const idA = idAt[a]!;
    const idB = idAt[b]!;
    idAt[a] = idB;
    idAt[b] = idA;
    indexOfId[idB] = a;
    indexOfId[idA] = b;
  };
  reset();
  return {
    capacity,
    get count() {
      return pool.count;
    },
    fields: pool.fields,
    // The next free id is already at position `count`.
    add: pool.add,
    addWithId: (id) => {
      if (id < 0 || id >= capacity || indexOfId[id]! < pool.count) {
        return -1;
      }
      swap(indexOfId[id]!, pool.count);
      return pool.add();
    },
    remove: (index) => {
      // The pool moves the last entity's fields into `index`; move its id the same way,
      // which leaves the removed id just past the live ones, so it's free.
      swap(index, pool.count - 1);
      pool.remove(index);
    },
    clear: () => {
      pool.clear();
      reset();
    },
    idOf: (index) => idAt[index]!,
    indexOf: (id) =>
      id >= 0 && id < capacity && indexOfId[id]! < pool.count
        ? indexOfId[id]!
        : -1,
  };
};
