import { Context, Effect, Layer } from "effect";
import type { Schema } from "effect";

import { loadOnce } from "./asset";
import type { Loaded } from "./asset";
import { loadContent } from "./loader";
import type { ContentDefinition, ContentError, ContentSource } from "./loader";

/** The key string of the content named `Name`. */
export type ContentId<Name extends string> =
  `arcadekit/content/Content/${Name}`;

/**
 * The type-level identity of a content service: what `MyContent.load` requires. It is the type
 * of the class's own values, so the class names it: `Layer.Layer<MyContent>`.
 */
export type ContentService<
  Name extends string,
  S extends Schema.Top,
> = Context.ServiceClass.Shape<
  ContentId<Name>,
  Loaded<S["Type"], ContentError>
>;

/** The class `Content` returns: the key of the content's service, its load and the Layer that provides it. */
export interface ContentClass<
  Name extends string,
  S extends Schema.Top,
> extends Context.ServiceClass<
  ContentService<Name, S>,
  ContentId<Name>,
  Loaded<S["Type"], ContentError>
> {
  readonly kind: "Content";
  readonly contentName: Name;
  readonly definition: ContentDefinition<S>;
  /** Loads and checks the content, or gives what is already loaded: `(yield* MyContent).load` as one Effect. */
  readonly load: Effect.Effect<
    S["Type"],
    ContentError,
    ContentService<Name, S>
  >;
  /**
   * Provides the content from `source`: `fetchJsonSource(url)` in an app. Building the layer
   * reads nothing. The first `load` reads every file, and a failed one can be run again.
   */
  readonly layer: (
    source: ContentSource
  ) => Layer.Layer<ContentService<Name, S>>;
  /**
   * Loads and checks the content from `source` and keeps nothing: for a test of a game's real
   * content files, which then runs the same checks as the game.
   */
  readonly read: (
    source: ContentSource
  ) => Effect.Effect<S["Type"], ContentError>;
}

/**
 * What a game is played with, as data: its levels, heroes, weapons. The declaration is the
 * content's Schema, the file each part comes from, and the checks the Schema can't express. The
 * class is the key of the service that loads it once per app.
 *
 * ```ts
 * export class PushPuzzleContent extends Content("PushPuzzleContent", {
 *   schema: PuzzleContent,
 *   files: { levels: "levels.json" },
 * }) {}
 *
 * // The app says where the files are:
 * PushPuzzleContent.layer(fetchJsonSource("/content/"));
 *
 * // And anything loads it:
 * const content = yield* PushPuzzleContent.load;
 * ```
 */
export const Content = <
  const Name extends string,
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  name: Name,
  definition: ContentDefinition<S>
): ContentClass<Name, S> => {
  const Key = Context.Service<
    ContentService<Name, S>,
    Loaded<S["Type"], ContentError>
  >()(`arcadekit/content/Content/${name}` as ContentId<Name>);
  const read = (source: ContentSource) =>
    loadContent({ ...definition, source });
  return class extends Key {
    static readonly kind = "Content" as const;
    static readonly contentName: Name = name;
    static readonly definition = definition;
    static readonly load = Effect.andThen(Key, (content) => content.load);
    static readonly layer = (source: ContentSource) =>
      Layer.effect(Key, loadOnce(read(source)));
    static readonly read = read;
  } as unknown as ContentClass<Name, S>;
};
