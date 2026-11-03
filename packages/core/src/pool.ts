type TypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array

type TypedArrayConstructor = new (length: number) => TypedArray

/** Field layout of a pool: field name -> typed array constructor, e.g. `{ x: Float32Array, hp: Float32Array }`. */
export type PoolLayout = Record<string, TypedArrayConstructor>

export type PoolFields<L extends PoolLayout> = { readonly [K in keyof L]: InstanceType<L[K]> }

/**
 * A fixed-capacity set of entities stored as "structure of arrays": one typed array per field,
 * with live entities packed into indices [0, count).
 *
 * Nothing is allocated after creation, so a game loop using pools never triggers garbage collection.
 * Removing swaps the last entity into the hole, so indices are not stable across removals:
 * remove while iterating backwards, or don't advance the index after a removal.
 */
export interface Pool<L extends PoolLayout> {
  readonly capacity: number
  readonly count: number
  readonly fields: PoolFields<L>
  /** Reserves the next slot and returns its index, or -1 when full. Field values in the slot are stale: set them all. */
  add(): number
  /** Removes the entity at `index` by moving the last entity into it. */
  remove(index: number): void
  clear(): void
}

export const createPool = <const L extends PoolLayout>(capacity: number, layout: L): Pool<L> => {
  const fields = Object.fromEntries(
    Object.entries(layout).map(([name, ArrayType]) => [name, new ArrayType(capacity)]),
  ) as unknown as PoolFields<L>
  const arrays = Object.values(fields) as TypedArray[]
  let count = 0
  return {
    capacity,
    get count() {
      return count
    },
    fields,
    add: () => (count < capacity ? count++ : -1),
    remove: index => {
      const last = --count
      if (index !== last) for (const array of arrays) array[index] = array[last]!
    },
    clear: () => {
      count = 0
    },
  }
}
