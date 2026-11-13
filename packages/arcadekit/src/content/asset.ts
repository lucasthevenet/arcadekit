/**
 * Assets: what a game draws or plays from that the app loads once, such as a sprite sheet.
 *
 * `Asset` is a declaration with a service: the class is the service's key, its `layer` provides
 * the service from the app's load, and its `load` loads the asset or gives the one already
 * loaded. `Loaded`, that one `load`, is a `Content`'s service too.
 *
 * @since 0.7.0
 */
import { Context, Effect, Layer } from "effect";

import { makeLoaded } from "./internal/loaded";

/**
 * Something an app loads once and keeps: the service of an `Asset` and of a `Content`. After a
 * successful `load`, later calls give the same value without loading again. A failed `load` isn't
 * kept, so running it again retries.
 *
 * **When to use**
 *
 * Name it when code reaches the service through its key, `(yield* GameSheet).load`. Most code runs
 * the class's own `load`, which is the same Effect.
 *
 * **Details**
 *
 * Callers at the same time share one load, and a caller that leaves doesn't cancel it for the
 * others: the load is interrupted only when every caller has left, and is then kept by no one. A
 * trace shows each `load` under the declared name, `GameSheet.load`.
 *
 * **Example** (Loading through the key)
 *
 * ```ts
 * import { Asset } from "arcadekit/content";
 * import type { Loaded } from "arcadekit/content";
 * import { Effect } from "effect";
 *
 * class Title extends Asset<string>()("Title") {}
 *
 * const program = Effect.gen(function* () {
 *   const title: Loaded<string, never> = yield* Title;
 *   return yield* title.load;
 * });
 * const title = Effect.runSync(program.pipe(Effect.provide(Title.layer(Effect.succeed("Demo")))));
 * title; // => "Demo"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Loaded<A, E> {
  readonly load: Effect.Effect<A, E>;
}

/**
 * The key string of the asset named `Name`.
 *
 * **When to use**
 *
 * Rarely: it is part of the asset's type, which a game names by its class.
 *
 * **Example** (An asset's key)
 *
 * ```ts
 * import { Asset } from "arcadekit/content";
 * import type { AssetId } from "arcadekit/content";
 *
 * class Title extends Asset<string>()("Title") {}
 *
 * const key: AssetId<"Title"> = Title.key;
 * key; // => "arcadekit/content/Asset/Title"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type AssetId<Name extends string> = `arcadekit/content/Asset/${Name}`;

/**
 * The type-level identity of an asset's service: what `MyAsset.load` requires. It is the type of
 * the class's own values, so the class names it: `Layer.Layer<MyAsset>`.
 *
 * **When to use**
 *
 * Rarely: name the class instead, as a requirement (`Effect.Effect<A, E, GameSheet>`) or a Layer's
 * service (`Layer.Layer<GameSheet>`).
 *
 * **Example** (The class names its service)
 *
 * ```ts
 * import { Asset } from "arcadekit/content";
 * import type { AssetService } from "arcadekit/content";
 * import { Effect, Layer } from "effect";
 *
 * class Title extends Asset<string>()("Title") {}
 *
 * const layer: Layer.Layer<AssetService<"Title", string, never>> = Title.layer(Effect.succeed("Demo"));
 * const same: Layer.Layer<Title> = layer;
 * Layer.isLayer(same); // => true
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type AssetService<
  Name extends string,
  A,
  E,
> = Context.ServiceClass.Shape<AssetId<Name>, Loaded<A, E>>;

/**
 * The class `Asset` returns: the key of the asset's service, its `load` and the `layer` that
 * provides it.
 *
 * **When to use**
 *
 * To type a value that is some asset's class, as a host that takes one does. A game names its own
 * class.
 *
 * **Example** (What the class holds)
 *
 * ```ts
 * import { Asset } from "arcadekit/content";
 * import type { AssetClass } from "arcadekit/content";
 *
 * class Title extends Asset<string>()("Title") {}
 *
 * const declared: AssetClass<"Title", string, never> = Title;
 * declared.kind; // => "Asset"
 * declared.assetName; // => "Title"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
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
 * Declares an asset: something a game draws or plays from that the app loads once, such as a
 * sprite sheet. The game declares it, with how to free it; the app says where it comes from, with
 * the class's `layer`; and whoever needs it runs `load`: the app's loading screen, to show a
 * failure and let the player retry, and a `Game.Engine`'s `uses`, on each attach.
 *
 * **When to use**
 *
 * For anything a view draws from or plays that takes a load the app should do once and can retry:
 * a sprite sheet, a font, a sound bank. A game's data, checked by a Schema, is a `Content`.
 *
 * **Details**
 *
 * The asset's type and its load's error are given first, in an empty call, as `Context.Service`
 * takes them. `release` frees the asset when the layer's scope closes, which in an app is when the
 * app ends; a load that succeeds after that is freed at once. Nothing else frees it: a view only
 * draws from it.
 *
 * **Example** (Declaring, providing and loading a sheet)
 *
 * ```ts
 * import { Asset } from "arcadekit/content";
 * import { Effect, Schema } from "effect";
 *
 * class SheetMissing extends Schema.TaggedError<SheetMissing>()("SheetMissing", {
 *   url: Schema.String,
 * }) {}
 * interface Sheet {
 *   readonly url: string;
 *   freed: boolean;
 * }
 *
 * // The genre declares it, with how to free it:
 * class RaceSheet extends Asset<Sheet, SheetMissing>()("RaceSheet", {
 *   release: (sheet) => {
 *     sheet.freed = true;
 *   },
 * }) {}
 *
 * // The app says where it comes from:
 * const sheet: Sheet = { url: "/sprites/race.png", freed: false };
 * const layer = RaceSheet.layer(Effect.succeed(sheet));
 *
 * // And anything loads it. The first success is kept, and the layer's end frees it:
 * const [first, second] = Effect.runSync(Effect.all([RaceSheet.load, RaceSheet.load]).pipe(Effect.provide(layer)));
 * first === second; // => true
 * sheet.freed; // => true
 * ```
 *
 * @category declarations
 * @since 0.7.0
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
        Layer.effect(Key, makeLoaded(`${name}.load`, load, options?.release));
    } as unknown as AssetClass<Name, A, E>;
  };
