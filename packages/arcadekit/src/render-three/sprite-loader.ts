import { Effect } from "effect";
import * as THREE from "three";

import { SpriteSheetError, decodeSpriteSheet } from "./sprite-sheet";
import type { SpriteSheetData } from "./sprite-sheet";
import { keepTexture } from "./stage";

/**
 * A sprite sheet ready to draw: its frames and tags, and its image as a texture.
 * The app loads it and owns it: views draw from it but never free it (`disposeObject` and
 * `Stage.dispose` skip its texture). The app calls `dispose` when it no longer needs it.
 */
export interface SpriteSheet {
  readonly data: SpriteSheetData;
  /** Nearest filtering, no mipmaps, sRGB, `flipY` off: row 0 of the image is v = 0. */
  readonly texture: THREE.Texture;
  readonly dispose: () => void;
}

/**
 * Makes a sheet from parsed data and an image that's already in memory, such as a canvas the
 * art was painted on. `loadSpriteSheet` uses it after fetching both files.
 */
export const makeSpriteSheet = (
  data: SpriteSheetData,
  image: TexImageSource
): SpriteSheet => {
  const texture = new THREE.Texture(image);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.premultiplyAlpha = false;
  texture.name = data.image;
  texture.needsUpdate = true;
  keepTexture(texture);
  return {
    data,
    texture,
    dispose: () => {
      texture.dispose();
      if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
        image.close();
      }
    },
  };
};

/**
 * Loads an Aseprite sheet: fetches the JSON at `jsonUrl`, then the image its `meta.image`
 * names, relative to the JSON. Fails with a `SpriteSheetError` naming the file when either
 * can't be fetched, the JSON is invalid, or the image's size isn't `meta.size`.
 */
export const loadSpriteSheet = (
  jsonUrl: string
): Effect.Effect<SpriteSheet, SpriteSheetError> =>
  Effect.gen(function* () {
    const json = yield* fetchFile(
      jsonUrl,
      (response) => response.json() as Promise<unknown>
    );
    const data = yield* decodeSpriteSheet(jsonUrl, json);
    const imageUrl = new URL(
      data.image,
      new URL(jsonUrl, globalThis.location.href)
    ).href;
    const image = yield* fetchFile(imageUrl, async (response) =>
      createImageBitmap(await response.blob(), {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      })
    );
    const { width, height } = image;
    if (width !== data.width || height !== data.height) {
      image.close();
      return yield* new SpriteSheetError({
        file: imageUrl,
        message: `The sprite sheet image ${imageUrl} is ${width}x${height}, but ${jsonUrl} says ${data.width}x${data.height}`,
      });
    }
    return makeSpriteSheet(data, image);
  });

const fetchFile = <A>(
  file: string,
  read: (response: Response) => Promise<A>
): Effect.Effect<A, SpriteSheetError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(file, { signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await read(response);
    },
    catch: (cause) =>
      new SpriteSheetError({
        file,
        message: `The sprite sheet file ${file} can't be loaded: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
