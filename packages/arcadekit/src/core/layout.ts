/**
 * Layouts: what each record of an entity pool, a ring or a tile map holds, as one typed array
 * per field.
 *
 * A game writes a layout once, as an object of typed array constructors, and makes its pools,
 * rings and tile maps from it. Each field is then one typed array, as long as the structure's
 * capacity, so a step that reads or writes a field touches numbers and allocates nothing.
 *
 * @since 0.7.0
 */

/**
 * A typed array a field is stored in: one of the eight a layout may name.
 *
 * **When to use**
 *
 * To recognise a field's array in a type computed from a run's state, as `Game.ReadonlyState`
 * does.
 *
 * **Example** (A field is one)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 * import type { Layout } from "arcadekit/core";
 *
 * const enemies = EntityPool.make(8, { hp: Float32Array });
 * const hp: Layout.TypedArray = enemies.fields.hp;
 * hp.length; // => 8
 * ```
 *
 * @category models
 * @since 0.8.0
 */
export type TypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array;

/** The methods of a typed array that write it, or give a view of it that could. */
type Writers = "copyWithin" | "fill" | "reverse" | "set" | "sort" | "subarray";

/**
 * A typed array that can be read and not written: its elements are read-only, and it has none of
 * the methods that write it in place.
 *
 * **When to use**
 *
 * Rarely by name: it is what a field of a read-only pool, ring or tile map is, and what
 * `Game.ReadonlyState` makes of a typed array in a run's state. Name it for a function of a
 * view that takes one field.
 *
 * **Details**
 *
 * It keeps every method that reads, and those that copy (`slice`, `map`, `toSorted`), and drops
 * `copyWithin`, `fill`, `reverse`, `set`, `sort` and `subarray`, which writes through the view it
 * gives. A writable array of the same kind is one, so a function that takes it takes either.
 *
 * **Example** (A view's sum of a field)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 * import type { Layout } from "arcadekit/core";
 *
 * const total = (field: Layout.ReadonlyTypedArray<Float32Array>, count: number): number => {
 *   let sum = 0;
 *   for (let i = 0; i < count; i++) {
 *     sum += field[i]!;
 *   }
 *   return sum;
 * };
 *
 * const enemies = EntityPool.make(8, { hp: Float32Array });
 * enemies.fields.hp[EntityPool.add(enemies)] = 3;
 * enemies.fields.hp[EntityPool.add(enemies)] = 4;
 * total(enemies.fields.hp, enemies.count); // => 7
 * ```
 *
 * @category utility types
 * @since 0.8.0
 */
export type ReadonlyTypedArray<A extends TypedArray> = Omit<
  A,
  Writers | number
> &
  Readonly<Record<number, number>>;

/**
 * The fields of a record, each named for what it holds and given the typed array it is stored
 * in: `{ x: Float32Array, hp: Float32Array }`.
 *
 * **When to use**
 *
 * Write one for each kind of record a game keeps in typed arrays, and give it to
 * `EntityPool.make`, `Ring.make` or `TileMap.make`.
 *
 * **Details**
 *
 * A layout is a plain object a game writes, not a value the kit makes, so it has no guard. Write
 * it `as const`, or pass it in place: the field names are then the keys of the structure's
 * `fields`, each with its own array type. Pick the smallest array that holds a field's values:
 * a `Uint8Array` for a tile kind, a `Float32Array` for a position.
 *
 * **Example** (Declaring a layout)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 * import type { Layout } from "arcadekit/core";
 *
 * const ENEMY_LAYOUT = {
 *   x: Float32Array,
 *   z: Float32Array,
 *   hp: Float32Array,
 *   type: Uint8Array,
 * } as const satisfies Layout.Layout;
 *
 * const enemies = EntityPool.make(300, ENEMY_LAYOUT);
 * enemies.fields.type instanceof Uint8Array; // => true
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Layout = Record<string, new (length: number) => TypedArray>;

/**
 * The typed arrays of a layout's fields, under the layout's names: what an entity pool's, a
 * ring's or a tile map's `fields` is.
 *
 * **When to use**
 *
 * Name it when a function takes the fields of a structure rather than the structure, such as a
 * step's helper that moves every entity.
 *
 * **Details**
 *
 * Each field is the instance type of its constructor, so `{ x: Float32Array }` gives a field `x`
 * of type `Float32Array`. The fields are readonly: a step writes their elements, never the
 * arrays.
 *
 * **Example** (Taking a pool's fields)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 * import type { Layout } from "arcadekit/core";
 *
 * const BODY = { x: Float32Array, speed: Float32Array } as const;
 *
 * const drift = (fields: Layout.Fields<typeof BODY>, count: number, dt: number) => {
 *   for (let i = 0; i < count; i++) {
 *     fields.x[i]! += fields.speed[i]! * dt;
 *   }
 * };
 *
 * const bodies = EntityPool.make(4, BODY);
 * const i = EntityPool.add(bodies);
 * bodies.fields.speed[i] = 2;
 * drift(bodies.fields, bodies.count, 0.5);
 * bodies.fields.x[i]; // => 1
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type Fields<L extends Layout> = {
  readonly [K in keyof L]: InstanceType<L[K]>;
};

/**
 * The fields of a layout as a reader of a run sees them: each a typed array that can be read and
 * not written.
 *
 * **When to use**
 *
 * Name it when a view's or a sample's function takes the fields of a structure rather than the
 * structure. It is what a read-only pool's, ring's or tile map's `fields` is.
 *
 * **Details**
 *
 * A structure's writable `fields` is one too, so a function that takes it takes either.
 *
 * **Example** (A view's count of the living)
 *
 * ```ts
 * import { EntityPool } from "arcadekit/core";
 * import type { Layout } from "arcadekit/core";
 *
 * const BODY = { hp: Float32Array } as const;
 *
 * const living = (fields: Layout.ReadonlyFields<typeof BODY>, count: number): number => {
 *   let alive = 0;
 *   for (let i = 0; i < count; i++) {
 *     alive += fields.hp[i]! > 0 ? 1 : 0;
 *   }
 *   return alive;
 * };
 *
 * const bodies = EntityPool.make(4, BODY);
 * bodies.fields.hp[EntityPool.add(bodies)] = 5;
 * EntityPool.add(bodies);
 * living(bodies.fields, bodies.count); // => 1
 * ```
 *
 * @category utility types
 * @since 0.8.0
 */
export type ReadonlyFields<L extends Layout> = {
  readonly [K in keyof L]: ReadonlyTypedArray<InstanceType<L[K]>>;
};
