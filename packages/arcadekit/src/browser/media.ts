import { Effect } from "effect";

import * as Assets from "../Assets";
import * as Sound from "../Sound";

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
 * What a streamed clip holds: only its URL.
 *
 * @internal
 */
export class Streamed {
  constructor(readonly url: string) {}
}

/**
 * Makes a streamed track, a `Sound.Clip` that holds only its file's URL. When
 * a channel plays it, the page fetches and decodes it progressively. A file
 * given by URL, and one made with `Browser.sound`, are fetched whole and kept
 * decoded instead. A long piece of music takes tens of megabytes that way,
 * and a few hundred kilobytes streamed.
 *
 *   // By name, for the page's whole lifetime:
 *   Browser.runMain(game, { sounds: { theme: Browser.stream("/theme.ogg") } })
 *
 *   // Or directly, where a level's music is chosen:
 *   const ForestTheme = Browser.stream("/forest.ogg")
 *   const Score = Sound.music("game/Score", function*() {
 *     return (yield* Level).value === "forest" ? ForestTheme : undefined
 *   })
 *
 * **Details**
 *
 * - It isn't an asset and belongs to no bundle. Nothing is fetched until it
 *   plays, so there is nothing to load or release, and it doesn't go through
 *   `Assets.Loader`. A test plays `Sound.clip(name)` instead.
 * - It is for a channel's track. Played as a cue, it is logged once through
 *   Effect's logger and not played, since a cue must sound immediately.
 * - It starts, fades and stops like any track, and with `once` plays to its
 *   end. A looping stream may have an audible seam where it loops, so load a
 *   short piece that must loop seamlessly with `Browser.sound`, which decodes
 *   it whole.
 *
 * @category Constructors
 */
export const stream = (url: string): Sound.Clip =>
  Sound.clip(url, new Streamed(url));

/**
 * Makes a sound asset, a `Sound.Clip` decoded and ready to play, which a
 * bundle loads with the rest of a level's assets. A cue or a track can play
 * it wherever it takes a sound's name.
 *
 *   const Forest = Assets.bundle("game/Forest", {
 *     chirp: Browser.sound("/chirp.wav"),
 *     theme: Browser.sound("/forest.ogg"),
 *   })
 *
 * **When to use**
 *
 * Use for a cue, or for a track that is short or must loop seamlessly. For a
 * long piece of music, use `Browser.stream`, which isn't decoded whole.
 *
 * **Details**
 *
 * - It is decoded whole into memory as it arrives, so a long track takes
 *   memory in proportion to its length.
 * - Once its bundle is released, the bundle no longer plays it. Whatever is
 *   still sounding plays to its end, or until its channel changes, and is
 *   freed afterwards.
 *
 * @category Constructors
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
 * Makes an image asset, an `ImageBitmap` decoded and ready to draw, which is
 * closed when the scope it was loaded in closes.
 *
 *   const Forest = Assets.bundle("game/Forest", {
 *     backdrop: Browser.image("/forest.png"),
 *   })
 *
 * @category Constructors
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
