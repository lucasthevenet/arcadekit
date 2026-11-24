import * as Assets from "arcadekit/Assets";
import { Effect } from "effect";
import type { Scope } from "effect";
import { LoadingManager, SRGBColorSpace, Texture } from "three";

import type { Kept } from "./scene";

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
 * Options for an image loaded with `Three.texture`.
 *
 * @category Options
 */
export interface TextureOptions {
  /**
   * Called once with the texture, before it is first uploaded to the renderer,
   * to mark it as non-colour data or to set its wrapping and filtering. The
   * texture it receives has no `flipY`, which the `flipY` option sets.
   */
  readonly prepare?: (texture: Omit<Texture, "flipY">) => void;
  /**
   * Whether the image is flipped vertically when it is decoded, so its first
   * row is at the top of a Three.js geometry. Defaults to `true`, as with a
   * `TextureLoader`. `false` keeps the file's orientation, which a model's own
   * UV coordinates expect.
   */
  readonly flipY?: boolean;
}

/**
 * Makes a texture asset, a Three.js `Texture` loaded with the rest of its
 * bundle. The texture and its image are disposed of when the scope it was
 * loaded in closes.
 *
 *   const Forest = Assets.bundle("game/Forest", {
 *     bark: Three.texture("/bark.png"),
 *     normals: Three.texture("/bark-normals.png", {
 *       prepare: (texture) => {
 *         texture.colorSpace = NoColorSpace
 *       },
 *     }),
 *   })
 *
 * **Details**
 *
 * - It is an sRGB colour image unless `prepare` sets another colour space.
 * - It is oriented for Three.js geometries unless `flipY: false` keeps the
 *   file's orientation. The orientation is an option, and `prepare` cannot set
 *   it, because a bitmap is flipped when it is decoded and Three.js ignores a
 *   bitmap's `flipY` afterwards.
 * - It is decoded off the page's main thread, with `createImageBitmap`.
 * - A file that isn't an image fails the bundle with `Assets.AssetFailed`,
 *   which names the URL.
 *
 * **Gotchas**
 *
 * - Node has no `createImageBitmap`, so a texture loads only in a page. Under
 *   Node, loading one fails its bundle.
 *
 * @category Constructors
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
 * Makes a Three.js `LoadingManager` that serves the files given, fetched
 * through `Assets.Loader`, to any Three.js loader made with it. Give it to a
 * loader that fetches for itself, such as a decoder of compressed models or
 * the FBX loader, so that a test's in-memory files serve that loader too, and
 * leaving a level while it loads cancels its requests.
 *
 *   const fbx = (url: string, textures: ReadonlyArray<string>) =>
 *     Assets.make(url, (data) =>
 *       Effect.map(Three.manager(textures), (manager) =>
 *         new FBXLoader(manager).parse(data.slice().buffer, "")
 *       )
 *     )
 *
 * **Details**
 *
 * - The files are fetched in parallel, and the manager is made once they have
 *   all arrived. A missing file fails with `Assets.AssetFailed`, which names it.
 * - A loader asks for a file by the URL it resolved: its path, then the name it
 *   was given. The manager matches that URL exactly against the files given.
 * - The files are held until the scope closes.
 *
 * **Gotchas**
 *
 * - A loader made with it that asks for any other URL is refused with an error
 *   that names the URL, which the loader passes on as its own. Add the URL to
 *   the files. A `blob:` or `data:` URL is served as it is, since it holds its
 *   bytes.
 *
 * @category Constructors
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
