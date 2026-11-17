/**
 * Resources are singletons with a default value, built on `Context.Reference`.
 *
 *   const Gravity = Resource.make("game/Gravity", { defaultValue: () => 9.81 })
 *   const g = yield* Gravity                      // 9.81 unless overridden
 *   App.make({ systems }).pipe(Effect.provide(Resource.layer(Gravity, 1.62)))
 */
import { Context, Layer } from "effect";

/**
 * Makes a resource: a value with a default, which a layer can override.
 *
 *   const Gravity = Resource.make("game/Gravity", { defaultValue: () => 9.81 })
 *
 * @category Constructors
 */
export const make = <A>(
  key: string,
  options: { readonly defaultValue: () => A }
): Context.Reference<A> => Context.Reference<A>(key, options);

/**
 * A layer that overrides a resource's default value.
 *
 * @category Layers
 */
export const layer = <A>(
  resource: Context.Reference<A>,
  value: A
): Layer.Layer<never> => Layer.succeed(resource, value) as Layer.Layer<never>;
