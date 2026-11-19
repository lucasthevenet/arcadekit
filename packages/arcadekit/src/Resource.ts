/**
 * Resources are configuration values with a default that a layer can override,
 * built on `Context.Reference`.
 *
 *   const Gravity = Resource.make("game/Gravity", { defaultValue: () => 9.81 })
 *   const g = yield* Gravity                      // 9.81 unless overridden
 *   App.make({ systems }).pipe(Effect.provide(Resource.layer(Gravity, 1.62)))
 *
 * A resource lives outside the world, so it is neither saved nor hashed. For
 * game state that exists once, use a singleton instead (`Singleton.define`).
 */
import { Context, Layer } from "effect";

/**
 * Makes a resource: a value with a default that a layer can override. Nothing
 * has to provide it.
 *
 *   const Gravity = Resource.make("game/Gravity", { defaultValue: () => 9.81 })
 *
 * **Gotchas**
 *
 * The default is created once and shared by every app in the process, so don't
 * mutate it.
 *
 * @category Constructors
 */
export const make = <A>(
  key: string,
  options: { readonly defaultValue: () => A }
): Context.Reference<A> => Context.Reference<A>(key, options);

/**
 * Returns a layer that overrides a resource's default value.
 *
 * @category Layers
 */
export const layer = <A>(
  resource: Context.Reference<A>,
  value: A
): Layer.Layer<never> => Layer.succeed(resource, value);
