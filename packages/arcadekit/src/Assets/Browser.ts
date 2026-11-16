/**
 * The assets only a page can make. This is the package's
 * `arcadekit/Assets/Browser` entry.
 *
 *   import * as AssetsBrowser from "arcadekit/Assets/Browser"
 *
 *   const Forest = Assets.bundle("game/Forest", {
 *     backdrop: AssetsBrowser.image("/forest.png"),
 *   })
 */
import { Effect } from "effect";

import * as Assets from "../Assets";

const describe = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

/**
 * An asset that is a picture, decoded and ready to draw: an `ImageBitmap`,
 * closed when the scope it was loaded in closes.
 */
export const image = (url: string): Assets.Asset<ImageBitmap> =>
  Assets.make(url, (data, at) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          // A copy: a Blob wants bytes that nothing else can change.
          createImageBitmap(new Blob([data.slice()])),
        catch: (error) =>
          new Assets.AssetFailed({
            url: at,
            message: `It could not be made a picture: ${describe(error)}`,
          }),
      }),
      (bitmap) => Effect.sync(() => bitmap.close())
    )
  );
