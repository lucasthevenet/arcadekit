/**
 * Values read-only all the way down, and the values JSON holds.
 *
 * No Effect dependency.
 */

/**
 * A value that is read-only all the way down. A `json`, `ref` or `transient`
 * field gives its value as one, so that the value is replaced, with `set` or
 * an assignment in `each`, and never changed in place. No change query would
 * see a change in place, and no refused action would undo it. A function, and
 * a value that is not an object, stay as they are.
 *
 * @category Type-level
 */
export type Frozen<A> = [JsonTree] extends [A] ? A : Freezing<A>;

// A type that holds any JSON tree is read-only already: stopping there keeps
// a recursive type from being expanded for ever.
type Freezing<A> = A extends (...args: never) => unknown
  ? A
  : A extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<K, Frozen<V>>
    : A extends ReadonlySet<infer V>
      ? ReadonlySet<Frozen<V>>
      : A extends object
        ? { readonly [K in keyof A]: Frozen<A[K]> }
        : A;

/** What an array or an object of a `json` field holds. */
type JsonTree =
  | string
  | number
  | boolean
  | null
  | readonly JsonTree[]
  | { readonly [key: string]: JsonTree };

/**
 * What a `json` field holds: a string, number, boolean, bigint, null or
 * undefined, or an array or object of strings, numbers, booleans and null.
 *
 * A `Date`, a `Map` or a class instance would not come back from a save as it
 * went in, so `Field.json` of a type that holds one doesn't compile. Give such
 * a value `Field.ref`, or `Field.schema` from `arcadekit`.
 *
 * @category Models
 */
export type JsonValue = JsonTree | bigint | undefined;
