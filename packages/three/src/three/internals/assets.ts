import * as Assets from "arcadekit/Assets";
import { Effect } from "effect";
import type { Scope } from "effect";
import { LoadingManager, SRGBColorSpace, Texture } from "three";

import type { TextureOptions } from "../Loading";
import type { Kept } from "./holdings";

/**
 * The assets of a bundle, whatever their types.
 *
 * @internal
 */
export type Entries = Readonly<Record<string, Assets.Asset<unknown>>>;

/**
 * What a system builds from a bundle's assets: available while the app has the
 * bundle loaded, released when it doesn't, and rebuilt from the next load.
 *
 * @internal
 */
export class FromAssets<T extends Kept> implements Kept {
  private assets: unknown;
  private made: T | undefined;

  constructor(
    private readonly store: Assets.StoreShape,
    private readonly bundle: Assets.Bundle<Entries>,
    // Handed the assets of `bundle`, and of no other.
    private readonly make: (assets: never) => T
  ) {}

  /** Returns the assets the app currently holds, if any. */
  private held(): unknown {
    const status = this.store.status(this.bundle);
    return status._tag === "Ready" ? status.assets : undefined;
  }

  /** Returns what is built from the assets the app currently holds, if it holds them. */
  now(): T | undefined {
    // Loaded again is loaded anew: other pictures, though of the same files.
    const assets = this.held();
    if (assets !== this.assets) {
      this.dispose();
      this.assets = assets;
      if (assets !== undefined) {
        this.made = this.make(assets as never);
      }
    }
    return this.made;
  }

  // Only lets go: what is loaded now is made something of by the system,
  // the next time it runs, which also has the entities to draw with it.
  readonly settle = (): void => {
    if (this.made !== undefined && this.held() !== this.assets) {
      this.dispose();
    }
  };

  dispose(): void {
    const { made } = this;
    this.made = undefined;
    made?.dispose();
  }
}

/**
 * Makes a texture asset: `Three.texture`.
 *
 * @internal
 */
export const texture = (
  url: string,
  options: TextureOptions = {}
): Assets.Asset<Texture> => {
  const flipY = options.flipY ?? true;
  return Assets.make(url, (data, at) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const bitmap = await createImageBitmap(
            // A copy: a Blob wants bytes that nothing else can change.
            new Blob([data.slice()]),
            { imageOrientation: flipY ? "flipY" : "from-image" }
          );
          const made = new Texture(bitmap);
          made.colorSpace = SRGBColorSpace;
          // What the texture says of itself is how it was decoded.
          made.flipY = flipY;
          options.prepare?.(made);
          made.needsUpdate = true;
          return made;
        },
        catch: (error) =>
          new Assets.AssetFailed({
            url: at,
            message: `It could not be made a texture: ${
              error instanceof Error
                ? error.message || error.name
                : String(error)
            }`,
          }),
      }),
      (made) =>
        Effect.sync(() => {
          made.dispose();
          (made.image as { close?: () => void } | null)?.close?.();
        })
    )
  );
};

/**
 * Makes a loading manager that serves the files given: `Three.manager`.
 *
 * @internal
 */
export const manager = (
  files: ReadonlyArray<string>
): Effect.Effect<LoadingManager, Assets.AssetFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const loader = yield* Assets.Loader;
    const fetched = yield* Effect.forEach(files, loader.bytes, {
      concurrency: "unbounded",
    });
    const served = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Map(
            files.map((url, i) => [
              url,
              // A copy: a Blob wants bytes that nothing else can change.
              URL.createObjectURL(new Blob([fetched[i]!.slice()])),
            ])
          )
      ),
      (urls) =>
        Effect.sync(() => {
          for (const url of urls.values()) {
            URL.revokeObjectURL(url);
          }
        })
    );
    return new LoadingManager().setURLModifier((url) => {
      const blob = served.get(url);
      if (blob !== undefined) {
        return blob;
      }
      if (url.startsWith("blob:") || url.startsWith("data:")) {
        return url;
      }
      throw new Error(
        `A Three.js loader asked for "${url}", which is not one of the files its manager serves. Add it to them.`
      );
    });
  });
