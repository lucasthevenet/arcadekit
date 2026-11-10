import { Context, Duration, Effect, Exit, Layer } from "effect";
import type { Scope } from "effect";

/**
 * Something an app loads once and keeps: content, a sprite sheet. After a successful `load`,
 * later calls give the same value without loading again. A failed `load` isn't kept, so calling
 * it again retries: a "Try again" button runs the same Effect. Callers at the same time share
 * one load, and a caller that leaves doesn't cancel it for the others.
 */
export interface Loaded<A, E> {
  readonly load: Effect.Effect<A, E>;
}

/**
 * Makes a `Loaded` from `load`, kept for as long as the scope is open. Making it loads nothing.
 * `release` frees the kept value when the scope closes; a load that finishes after that is
 * freed at once.
 */
export const loadOnce = <A, E, R>(
  load: Effect.Effect<A, E, R>,
  release?: (value: A) => void
): Effect.Effect<Loaded<A, E>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    let kept: { readonly value: A } | undefined;
    // The load runs on a fiber the scope doesn't track, so it can finish after the scope closed.
    let closed = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
        if (kept !== undefined) {
          release?.(kept.value);
        }
      })
    );
    const cached = yield* Effect.cachedWithTTL(
      load.pipe(
        Effect.provideContext(context),
        Effect.map((value) => {
          if (closed) {
            release?.(value);
          } else {
            kept = { value };
          }
          return value;
        })
      ),
      (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)
    );
    return { load: cached };
  });

/** The key string of the asset named `Name`. */
export type AssetId<Name extends string> = `arcadekit/content/Asset/${Name}`;

/**
 * The type-level identity of an asset's service: what `MyAsset.load` requires. It is the type of
 * the class's own values, so the class names it: `Layer.Layer<MyAsset>`.
 */
export type AssetService<
  Name extends string,
  A,
  E,
> = Context.ServiceClass.Shape<AssetId<Name>, Loaded<A, E>>;

/** The class `Asset` returns: the key of the asset's service, its load and the Layer that provides it. */
export interface AssetClass<
  Name extends string,
  A,
  E,
> extends Context.ServiceClass<
  AssetService<Name, A, E>,
  AssetId<Name>,
  Loaded<A, E>
> {
  readonly kind: "Asset";
  readonly assetName: Name;
  /** Loads the asset, or gives the one already loaded: `(yield* MyAsset).load` as one Effect. */
  readonly load: Effect.Effect<A, E, AssetService<Name, A, E>>;
  /**
   * Provides the asset from `load`, which runs on the first `MyAsset.load` and again after each
   * failure. Building the layer loads nothing. The layer's scope (the app) frees the asset.
   */
  readonly layer: <R>(
    load: Effect.Effect<A, E, R>
  ) => Layer.Layer<AssetService<Name, A, E>, never, R>;
}

/**
 * Something a game draws or plays from that the app loads once, such as a sprite sheet. The game
 * declares it, with how to free it; the app says where it comes from; and whoever needs it runs
 * `load`: the app's loading screen, to show a failure and let the player retry, and the engine,
 * on each attach.
 *
 * ```ts
 * // The genre declares it:
 * export class PushPuzzleSheet extends Asset<SpriteSheet, SpriteSheetError>()(
 *   "PushPuzzleSheet",
 *   { release: (sheet) => sheet.dispose() }
 * ) {}
 *
 * // The app provides it:
 * PushPuzzleSheet.layer(loadSpriteSheet("/sprites/push-puzzle.json"));
 *
 * // And anything loads it:
 * const sheet = yield* PushPuzzleSheet.load;
 * ```
 *
 * The asset's type and error are given first, as with `Context.Service`.
 */
export const Asset =
  <A, E = never>() =>
  <const Name extends string>(
    name: Name,
    options?: {
      /** Frees the asset when the app ends. Nothing else frees it: a view only draws from it. */
      readonly release?: (asset: A) => void;
    }
  ): AssetClass<Name, A, E> => {
    const Key = Context.Service<AssetService<Name, A, E>, Loaded<A, E>>()(
      `arcadekit/content/Asset/${name}` as AssetId<Name>
    );
    return class extends Key {
      static readonly kind = "Asset" as const;
      static readonly assetName: Name = name;
      static readonly load = Effect.andThen(Key, (asset) => asset.load);
      static readonly layer = <R>(load: Effect.Effect<A, E, R>) =>
        Layer.effect(Key, loadOnce(load, options?.release));
    } as unknown as AssetClass<Name, A, E>;
  };
