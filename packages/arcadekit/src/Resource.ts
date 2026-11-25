/**
 * Resources are configuration values with a default that a layer can override,
 * built on `Context.Reference`.
 *
 *   const Gravity = Resource.make("game/Gravity", { defaultValue: () => 9.81 })
 *   const g = yield* Gravity                      // 9.81 unless overridden
 *   App.make(App.define({ systems })).pipe(Effect.provide(Resource.layer(Gravity, 1.62)))
 *
 * A resource lives outside the world, so no save holds it and the world's hash
 * leaves it out. For game state that exists once, use a singleton, made with
 * `Singleton.define`.
 */
import { Context, Layer } from "effect";

import type { Frozen as Deep } from "./ecs/frozen.ts";

/**
 * A resource's value, read-only all the way down, since every app that reads
 * the resource shares one value. A function, and a value that is not an
 * object, keep their own type.
 *
 * @category Type-level
 */
export type Frozen<A> = Deep<A>;

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
 * Makes a resource, a value with a default that a layer can override. Nothing
 * has to provide it.
 *
 *   const Gravity = Resource.make("game/Gravity", { defaultValue: () => 9.81 })
 *
 * **Gotchas**
 *
 * The default is created once, and every app in the process shares it, so the
 * value is read-only. Its type says so all the way down. A plain object or
 * array in it is frozen, so a write to one throws. To change the value,
 * provide another with `Resource.layer`.
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
 * Returns a layer that overrides a resource's default value. It freezes the
 * value as `Resource.make` freezes a default.
 *
 * @category Layers
 */
export const layer = <A>(
  resource: Context.Reference<A>,
  value: A
): Layer.Layer<never> =>
  Layer.succeed(resource, freeze(value) as A) as Layer.Layer<never>;
