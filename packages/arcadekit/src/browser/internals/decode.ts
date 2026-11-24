import { Effect } from "effect";

import * as Assets from "../../Assets";
import * as Sound from "../../Sound";

/**
 * What went wrong, said for a message.
 *
 * @internal
 */
export const describe = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

/**
 * Decodes a sound. Decoding needs no touch, only playing does: a context that
 * plays nothing decodes a file as soon as it is there.
 *
 * @internal
 */
export const decodeOffline = (data: ArrayBuffer): Promise<unknown> =>
  new OfflineAudioContext(1, 1, 44_100).decodeAudioData(data);

/**
 * Makes a sound asset: `Browser.sound`.
 *
 * @internal
 */
export const sound = (url: string): Assets.Asset<Sound.Clip> =>
  Assets.make(url, (data, at) =>
    Effect.tryPromise({
      // A copy: decoding keeps the buffer it is given.
      try: async () => Sound.clip(at, await decodeOffline(data.slice().buffer)),
      catch: (error) =>
        new Assets.AssetFailed({
          url: at,
          message: `It could not be made a sound: ${describe(error)}`,
        }),
    })
  );

/**
 * Makes an image asset: `Browser.image`.
 *
 * @internal
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
