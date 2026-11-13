/**
 * Fetch content sources: a game's content files read over HTTP with `fetch`, as a browser gets the
 * files an app ships beside its code.
 *
 * It is a `ContentSource` like any other, in an entry of its own: `fetch` is a browser's (or
 * another runtime's), and the root entry is checked with no DOM types (ADR-0002).
 *
 * @since 0.7.0
 */
import { Effect } from "effect";

import { ContentSource } from "../index";

/**
 * Makes a content source that fetches each file from `baseUrl` and parses it as JSON: the file
 * `levels.json` of `fromUrl("/content/")` is `/content/levels.json`.
 *
 * **When to use**
 *
 * In an app, for the content files it serves beside its code: hand it to the game's `Content`
 * declaration's `layer`.
 *
 * **Details**
 *
 * `baseUrl` ends with `/`, and each file's name is joined to it as it is. Making the source
 * fetches nothing: each read of a file fetches it. Every failure is a `ContentSource.ContentError`
 * that names the file: a request that fails (with what `fetch` threw as its `cause`), a response
 * that isn't a success (with its HTTP status), or a body that isn't JSON. A read that is
 * interrupted while its request is open aborts the request.
 *
 * **Example** (The app's content, served beside it)
 *
 * ```ts
 * import { Content, ContentSource } from "arcadekit/content";
 * import { FetchContentSource } from "arcadekit/content/browser";
 * import { Effect, Layer, Schema } from "effect";
 *
 * class RaceContent extends Content("RaceContent", {
 *   schema: Schema.Struct({ tracks: Schema.Array(Schema.String) }),
 *   files: { tracks: "tracks.json" },
 * }) {}
 *
 * // Making the source and the layer fetches nothing:
 * const source = FetchContentSource.fromUrl("/content/");
 * Layer.isLayer(RaceContent.layer(source)); // => true
 *
 * // Each run of a read fetches its file, here /content/tracks.json:
 * Effect.isEffect(ContentSource.read(source, "tracks.json")); // => true
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const fromUrl = (baseUrl: string): ContentSource.ContentSource =>
  ContentSource.make(
    Effect.fnUntraced(function* (file: string) {
      const url = `${baseUrl}${file}`;
      const response = yield* Effect.tryPromise({
        try: (signal) => fetch(url, { signal }),
        catch: (cause) =>
          new ContentSource.ContentError({
            message: `Could not load ${file}: ${String(cause)}`,
            cause,
          }),
      });
      if (!response.ok) {
        return yield* new ContentSource.ContentError({
          message: `Could not load ${file}: HTTP ${response.status}`,
        });
      }
      return yield* Effect.tryPromise({
        try: (): Promise<unknown> => response.json(),
        catch: (cause) =>
          new ContentSource.ContentError({
            message: `Could not read ${file} as JSON: ${String(cause)}`,
            cause,
          }),
      });
    })
  );
