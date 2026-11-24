/**
 * Three.js resources loaded with a bundle of `arcadekit/Assets`: a texture,
 * and a loading manager for a Three.js loader that fetches for itself.
 *
 *   import * as Assets from "arcadekit/Assets"
 *   import * as ThreeAssets from "@arcadekit/three/Assets"
 *
 *   const Forest = Assets.bundle("game/Forest", {
 *     bark: ThreeAssets.texture("/bark.png"),
 *   })
 *
 * `@arcadekit/three/Three` gives the same exports. They fetch through
 * `Assets.Loader`, so a test's in-memory files serve them too, and they are
 * disposed of when their bundle is released.
 */
import type * as Assets from "arcadekit/Assets";
import type { Effect, Scope } from "effect";
import type { LoadingManager, Texture } from "three";

import * as internal from "./internals/assets";

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
export const texture: (
  url: string,
  options?: TextureOptions
) => Assets.Asset<Texture> = internal.texture;

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
export const manager: (
  files: ReadonlyArray<string>
) => Effect.Effect<LoadingManager, Assets.AssetFailed, Scope.Scope> =
  internal.manager;
