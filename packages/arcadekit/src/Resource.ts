/**
 * Resources are configuration values with a default that a layer can override,
 * built on `Context.Reference`.
 *
 *   const Gravity = Resource.make("game/Gravity", { defaultValue: () => 9.81 })
 *   const g = yield* Gravity                      // 9.81 unless overridden
 *   App.make(App.define({ systems })).pipe(Effect.provide(Resource.layer(Gravity, 1.62)))
 *
 * A resource lives outside the world, so it is neither saved nor hashed. For
 * game state that exists once, use a singleton instead (`Singleton.define`).
 */
import { Context, Layer } from "effect";

/**
 * A resource's value: read-only all the way down, since one value is shared
 * by every app that reads it. A function, and what isn't an object, are as
 * they are.
 *
 * @category Type-level
 */
export type Frozen<A> = A extends (...args: never) => unknown
  ? A
  : A extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<K, Frozen<V>>
    : A extends ReadonlySet<infer V>
      ? ReadonlySet<Frozen<V>>
      : A extends object
        ? { readonly [K in keyof A]: Frozen<A[K]> }
        : A;

/** Freezes plain objects and arrays, and what they hold, in place. */
const freeze = <A>(value: A): Frozen<A> => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    const proto: unknown = Object.getPrototypeOf(value);
    if (Array.isArray(value) || proto === Object.prototype || proto === null) {
      Object.freeze(value);
      for (const held of Object.values(value)) {
        freeze(held);
      }
    }
  }
  return value as Frozen<A>;
};

/**
 * Makes a resource: a value with a default that a layer can override. Nothing
 * has to provide it.
 *
 *   const Gravity = Resource.make("game/Gravity", { defaultValue: () => 9.81 })
 *
 * The default is created once and shared by every app in the process, so the
 * value is read-only: its type says so all the way down, and a plain object or
 * array is frozen, so that a write to one throws. To change it, provide
 * another value with `Resource.layer`.
 *
 * @category Constructors
 */
export const make = <A>(
  key: string,
  options: { readonly defaultValue: () => A }
): Context.Reference<Frozen<A>> =>
  Context.Reference<Frozen<A>>(key, {
    defaultValue: () => freeze(options.defaultValue()),
  });

/**
 * Returns a layer that overrides a resource's default value. The value is
 * frozen as a default is.
 *
 * @category Layers
 */
export const layer = <A>(
  resource: Context.Reference<A>,
  value: A
): Layer.Layer<never> =>
  Layer.succeed(resource, freeze(value) as A) as Layer.Layer<never>;
