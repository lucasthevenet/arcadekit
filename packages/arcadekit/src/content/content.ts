/**
 * Content: what a game is played with, as data (its levels, heroes, weapons), checked by an Effect
 * Schema and loaded once per app.
 *
 * `Content` is a declaration with a service, as `Asset` is: the class is the service's key, its
 * `layer` provides the service from a content source, and its `load` reads and checks every file
 * once and keeps the first success. Its `read` runs the same checks and keeps nothing, for a test
 * of a game's real files.
 *
 * @since 0.7.0
 */
import { Context, Effect, Layer, Schema } from "effect";

import type { Loaded } from "./asset";
import type * as ContentSource from "./content-source";
import { ContentError, read as readFile } from "./content-source";
import { makeLoaded } from "./internal/loaded";

/**
 * What `Content` takes: a game's Schema, the file each part comes from, and the checks the Schema
 * can't express. A declaration keeps it as its `definition`, and its `layer` and its `read` check
 * with the same one.
 *
 * **When to use**
 *
 * Read it from a declared content's `definition`, as a test or a tool does that lists the files a
 * game ships.
 *
 * **Details**
 *
 * `schema` is a struct, and `files` names the file of each of its fields: each field is read from
 * its own file. `validate` gets the decoded content and returns one message per problem, such as
 * an id that points at no entry.
 *
 * **Example** (The files a declaration reads)
 *
 * ```ts
 * import { Content } from "arcadekit/content";
 * import type { ContentDefinition } from "arcadekit/content";
 * import { Schema } from "effect";
 *
 * const RaceFiles = Schema.Struct({ tracks: Schema.Array(Schema.String), title: Schema.String });
 *
 * class RaceContent extends Content("RaceContent", {
 *   schema: RaceFiles,
 *   files: { tracks: "tracks.json", title: "title.json" },
 * }) {}
 *
 * const definition: ContentDefinition<typeof RaceFiles> = RaceContent.definition;
 * Object.values(definition.files); // => ["tracks.json", "title.json"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface ContentDefinition<S extends Schema.Top> {
  /** Schema for the whole content object. A struct: each field is loaded from its own file. */
  readonly schema: S;
  /** Which file fills each top-level field. */
  // oxlint-disable-next-line typescript/consistent-indexed-object-style -- a mapped type keeps the schema's per-field modifiers; Record drops them.
  readonly files: { readonly [K in keyof S["Type"] & string]: string };
  /** Checks the schema can't express, like ids that must point at other entries. Return one message per problem. */
  readonly validate?: (content: S["Type"]) => readonly string[];
}

/**
 * The key string of the content named `Name`.
 *
 * **When to use**
 *
 * Rarely: it is part of the content's type, which a game names by its class.
 *
 * **Example** (A content's key)
 *
 * ```ts
 * import { Content } from "arcadekit/content";
 * import type { ContentId } from "arcadekit/content";
 * import { Schema } from "effect";
 *
 * class RaceContent extends Content("RaceContent", {
 *   schema: Schema.Struct({ title: Schema.String }),
 *   files: { title: "title.json" },
 * }) {}
 *
 * const key: ContentId<"RaceContent"> = RaceContent.key;
 * key; // => "arcadekit/content/Content/RaceContent"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type ContentId<Name extends string> =
  `arcadekit/content/Content/${Name}`;

/**
 * The type-level identity of a content service: what `MyContent.load` requires. It is the type of
 * the class's own values, so the class names it: `Layer.Layer<MyContent>`.
 *
 * **When to use**
 *
 * Rarely: name the class instead, as a requirement (`Effect.Effect<A, E, GameContent>`) or a
 * Layer's service (`Layer.Layer<GameContent>`).
 *
 * **Example** (The class names its service)
 *
 * ```ts
 * import { Content, ContentSource } from "arcadekit/content";
 * import type { ContentService } from "arcadekit/content";
 * import { Layer, Schema } from "effect";
 *
 * const Title = Schema.Struct({ title: Schema.String });
 * class RaceContent extends Content("RaceContent", {
 *   schema: Title,
 *   files: { title: "title.json" },
 * }) {}
 *
 * const source = ContentSource.fromRecord({ "title.json": "Demo" });
 * const layer: Layer.Layer<ContentService<"RaceContent", typeof Title>> = RaceContent.layer(source);
 * const same: Layer.Layer<RaceContent> = layer;
 * Layer.isLayer(same); // => true
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type ContentService<
  Name extends string,
  S extends Schema.Top,
> = Context.ServiceClass.Shape<
  ContentId<Name>,
  Loaded<S["Type"], ContentError>
>;

/**
 * The class `Content` returns: the key of the content's service, its `load`, the `layer` that
 * provides it, and the `read` that checks a source's files and keeps nothing.
 *
 * **When to use**
 *
 * To type a value that is some content's class, as a host that takes one does. A game names its
 * own class.
 *
 * **Example** (What the class holds)
 *
 * ```ts
 * import { Content } from "arcadekit/content";
 * import type { ContentClass } from "arcadekit/content";
 * import { Schema } from "effect";
 *
 * const Title = Schema.Struct({ title: Schema.String });
 * class RaceContent extends Content("RaceContent", {
 *   schema: Title,
 *   files: { title: "title.json" },
 * }) {}
 *
 * const declared: ContentClass<"RaceContent", typeof Title> = RaceContent;
 * declared.kind; // => "Content"
 * declared.contentName; // => "RaceContent"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
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
   * Provides the content from `source`: `FetchContentSource.fromUrl(url)` in an app. Building the
   * layer reads nothing. The first `load` reads every file, and a failed one can be run again.
   */
  readonly layer: (
    source: ContentSource.ContentSource
  ) => Layer.Layer<ContentService<Name, S>>;
  /**
   * Reads and checks the content from `source` and keeps nothing: for a test of a game's real
   * content files, which then runs the same checks as the game.
   */
  readonly read: (
    source: ContentSource.ContentSource
  ) => Effect.Effect<S["Type"], ContentError>;
}

/**
 * Declares a game's content: what it is played with, as data (its levels, heroes, weapons). The
 * declaration is the content's Schema, the file each part comes from, and the checks the Schema
 * can't express. The class is the key of the service that loads it once per app.
 *
 * **When to use**
 *
 * For a game's data files, which an app ships beside its code and a test reads as they are. What a
 * view draws from, such as a sprite sheet, is an `Asset`.
 *
 * **Details**
 *
 * The app provides it with `layer(source)`, and anything loads it with `load`: every file is read
 * at once, then the whole is decoded with the Schema, then `validate` runs. Each failure is a
 * `ContentSource.ContentError` whose message names the file or the problem. The first success is
 * kept for as long as the layer's scope is open, and a failure isn't, so a "Try again" runs the
 * same `load`. `read(source)` does the same reading and checks and keeps nothing. A trace shows
 * each `load` as `<Name>.load` and each reading of the files as `<Name>.read`.
 *
 * **Example** (Declaring, providing and loading a game's tracks)
 *
 * ```ts
 * import { Content, ContentSource } from "arcadekit/content";
 * import { Effect, Schema } from "effect";
 *
 * // The genre declares its content:
 * class RaceContent extends Content("RaceContent", {
 *   schema: Schema.Struct({ tracks: Schema.Array(Schema.String) }),
 *   files: { tracks: "tracks.json" },
 *   validate: (content) => (content.tracks.length === 0 ? ["tracks.json has no tracks"] : []),
 * }) {}
 *
 * // The app says where the files are:
 * const layer = RaceContent.layer(ContentSource.fromRecord({ "tracks.json": ["oval"] }));
 *
 * // And anything loads it:
 * const content = Effect.runSync(RaceContent.load.pipe(Effect.provide(layer)));
 * content.tracks; // => ["oval"]
 *
 * // A test reads files with the same checks:
 * const empty = ContentSource.fromRecord({ "tracks.json": [] });
 * const error = Effect.runSync(Effect.flip(RaceContent.read(empty)));
 * error.message; // => "Content problems: tracks.json has no tracks"
 * ```
 *
 * @category declarations
 * @since 0.7.0
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
  const decode = Schema.decodeUnknownEffect(definition.schema);
  const read = Effect.fn(`${name}.read`)(function* (
    source: ContentSource.ContentSource
  ) {
    const raw = yield* Effect.all(
      Object.fromEntries(
        Object.entries<string>(definition.files).map(([field, file]) => [
          field,
          readFile(source, file),
        ])
      ),
      { concurrency: "unbounded" }
    );
    const content = yield* decode(raw).pipe(
      Effect.mapError(
        (error) =>
          new ContentError({ message: `Invalid content: ${error.message}` })
      )
    );
    const problems = definition.validate?.(content) ?? [];
    if (problems.length > 0) {
      return yield* new ContentError({
        message: `Content problems: ${problems.join("; ")}`,
      });
    }
    return content;
  });
  return class extends Key {
    static readonly kind = "Content" as const;
    static readonly contentName: Name = name;
    static readonly definition = definition;
    static readonly load = Effect.andThen(Key, (content) => content.load);
    static readonly layer = (source: ContentSource.ContentSource) =>
      Layer.effect(Key, makeLoaded(`${name}.load`, read(source)));
    static readonly read = read;
  } as unknown as ContentClass<Name, S>;
};
