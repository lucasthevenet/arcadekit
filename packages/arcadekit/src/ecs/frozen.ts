/**
 * Values read-only all the way down, and the values JSON holds.
 *
 * No Effect dependency.
 */

/**
 * A value read-only all the way down: what a field that holds an object
 * gives, so that the value is replaced with `set` and not changed in place,
 * which no change query would see and no refused action would undo. A
 * function, and what isn't an object, are as they are.
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
 * A `Date`, a `Map` or a class doesn't come back from a save as it went in:
 * give it `Field.schema` or `Field.ref`.
 *
 * @category Type-level
 */
export type JsonValue = JsonTree | bigint | undefined;
