/**
 * Content sources: where a game's content files come from, read one file at a time by its name.
 *
 * A `Content` declaration says which file fills each part of its content, and the app says where
 * the files are by handing its `layer` a source: `FetchContentSource.fromUrl` in a browser
 * (`arcadekit/content/browser`), `fromRecord` in a test. A source gives a file's parsed contents
 * and checks nothing: the declaration's Schema and `validate` do, the same for every source.
 *
 * @since 0.7.0
 */
import { Effect, Inspectable, Pipeable, Predicate, Schema } from "effect";
import type { Cause, Types } from "effect";
import { dual } from "effect/Function";

const TypeId = "~arcadekit/content/ContentSource";

/** The class `Schema.TaggedError` makes for `ContentError`, written out for isolatedDeclarations. */
type ContentErrorClass = Schema.Class<
  ContentError,
  Schema.TaggedStruct<
    "ContentError",
    {
      readonly message: Schema.String;
      readonly cause: Schema.optional<Schema.Defect>;
    }
  >,
  Cause.YieldableError
>;

// Named so the type files can be made one file at a time (isolatedDeclarations).
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError makes a class; it is not an error being thrown.
const ContentErrorBase: ContentErrorClass = Schema.TaggedError<ContentError>()(
  "ContentError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
);

/**
 * The error every content source and every load of content fails with: a file that couldn't be
 * read, content its Schema refuses, or a problem its `validate` found. Its `message` names the
 * file or the problem, for the app to show.
 *
 * **When to use**
 *
 * Make one in a source of the app's own, for a file it can't give. An app catches it by its tag,
 * `Effect.catchTag("ContentError", ...)`, to show a loading screen's failure.
 *
 * **Details**
 *
 * `cause` is what was thrown, when a source wraps a throw (a failed `fetch`, a parse): it is for a
 * log, and the `message` is for the player.
 *
 * **Example** (Reading a file a source doesn't have)
 *
 * ```ts
 * import { ContentSource } from "arcadekit/content";
 * import { Effect } from "effect";
 *
 * const source = ContentSource.fromRecord({ "levels.json": [] });
 * const error = Effect.runSync(Effect.flip(ContentSource.read(source, "heroes.json")));
 * error._tag; // => "ContentError"
 * error.message; // => "No content file named heroes.json"
 * ```
 *
 * @category errors
 * @since 0.7.0
 */
export class ContentError extends ContentErrorBase {}

/**
 * A content source: a read of one content file by its name, which gives the file's parsed
 * contents or fails with a `ContentError`.
 *
 * **When to use**
 *
 * Hand one to a `Content` declaration's `layer` in the app, and to its `read` in a test of the
 * game's real files.
 *
 * **Details**
 *
 * A source checks nothing: what it gives is `unknown`, and the declaration decodes it with its
 * Schema. Reading a file twice reads it twice; a declaration's `layer` is what keeps a success.
 *
 * **Example** (Giving a declaration its files)
 *
 * ```ts
 * import { Content, ContentSource } from "arcadekit/content";
 * import { Effect, Schema } from "effect";
 *
 * class RaceContent extends Content("RaceContent", {
 *   schema: Schema.Struct({ tracks: Schema.Array(Schema.String) }),
 *   files: { tracks: "tracks.json" },
 * }) {}
 *
 * const source: ContentSource.ContentSource = ContentSource.fromRecord({
 *   "tracks.json": ["oval", "figure eight"],
 * });
 * const content = Effect.runSync(RaceContent.read(source));
 * content.tracks; // => ["oval", "figure eight"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface ContentSource
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
}

/** What the module's functions keep, which no caller reads. */
type Internal = ContentSource & {
  /** The read the source was made from. */
  readonly readFile: (file: string) => Effect.Effect<unknown, ContentError>;
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON() {
    return { _id: "ContentSource" };
  },
};

/**
 * Checks whether a value is a content source.
 *
 * **When to use**
 *
 * Narrow an unknown value before handing it to a declaration as its source.
 *
 * **Details**
 *
 * A source comes from `make` or one of the module's other constructors. A function of a file's
 * name, which a source was before it was a value, is none.
 *
 * **Example** (Recognising a source)
 *
 * ```ts
 * import { ContentSource } from "arcadekit/content";
 * import { Effect } from "effect";
 *
 * ContentSource.isContentSource(ContentSource.fromRecord({})); // => true
 * ContentSource.isContentSource((file: string) => Effect.succeed(file)); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isContentSource = (value: unknown): value is ContentSource =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a content source from a read of one file: given a file's name, an Effect that gives its
 * parsed contents, or fails with a `ContentError` for a file it can't give.
 *
 * **When to use**
 *
 * For files the kit has no source for: a test's files on disk, files bundled into the app, or a
 * source made of two others (a player's mods over the game's own files).
 *
 * **Details**
 *
 * `readFile` runs each time a file is read, when the read runs, and not when the source is made.
 * Wrap what throws with `Effect.try` or `Effect.tryPromise`, into a `ContentError` with the throw
 * as its `cause`.
 *
 * **Example** (Files bundled into the app as JSON text)
 *
 * ```ts
 * import { ContentSource } from "arcadekit/content";
 * import { Effect } from "effect";
 *
 * const texts: Readonly<Record<string, string>> = { "title.json": '"Demo"' };
 * const bundled = ContentSource.make((file) =>
 *   Effect.try({
 *     try: () => JSON.parse(texts[file] ?? ""),
 *     catch: (cause) =>
 *       new ContentSource.ContentError({ message: `Could not read ${file}`, cause }),
 *   })
 * );
 *
 * Effect.runSync(ContentSource.read(bundled, "title.json")); // => "Demo"
 * const error = Effect.runSync(Effect.flip(ContentSource.read(bundled, "levels.json")));
 * error.message; // => "Could not read levels.json"
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (
  readFile: (file: string) => Effect.Effect<unknown, ContentError>
): ContentSource => {
  const self = Object.create(Proto) as Types.Mutable<Internal>;
  self.readFile = readFile;
  return self;
};

/**
 * Makes a content source that serves files from a record of them, by name: each value is a file's
 * parsed contents.
 *
 * **When to use**
 *
 * In a test of a game's content rules, with the files written beside the test, or for content
 * the app builds into its code.
 *
 * **Details**
 *
 * A name the record doesn't have fails with a `ContentError` that names the file. Only the
 * record's own keys are files: `"constructor"` is none.
 *
 * **Example** (A test's files)
 *
 * ```ts
 * import { ContentSource } from "arcadekit/content";
 * import { Effect } from "effect";
 *
 * const source = ContentSource.fromRecord({ "levels.json": [{ id: "first" }] });
 * Effect.runSync(ContentSource.read(source, "levels.json")); // => [{ id: "first" }]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const fromRecord = (
  files: Readonly<Record<string, unknown>>
): ContentSource =>
  make((file) =>
    Object.hasOwn(files, file)
      ? Effect.succeed(files[file])
      : Effect.fail(
          new ContentError({ message: `No content file named ${file}` })
        )
  );

/**
 * Reads one file of a source by its name: its parsed contents, unchecked, or the source's
 * `ContentError`.
 *
 * **When to use**
 *
 * In a source made of others, and in a test of a source. A game reads its content through its
 * `Content` declaration, which reads each of its files with this and checks them.
 *
 * **Details**
 *
 * A trace shows each read as `ContentSource.read`. Nothing is kept: reading the file again reads
 * it again.
 *
 * **Example** (Reading a file, data first or piped)
 *
 * ```ts
 * import { ContentSource } from "arcadekit/content";
 * import { Effect } from "effect";
 *
 * const source = ContentSource.fromRecord({ "title.json": "Demo" });
 * Effect.runSync(ContentSource.read(source, "title.json")); // => "Demo"
 * Effect.runSync(source.pipe(ContentSource.read("title.json"))); // => "Demo"
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const read: {
  (file: string): (self: ContentSource) => Effect.Effect<unknown, ContentError>;
  (self: ContentSource, file: string): Effect.Effect<unknown, ContentError>;
} = dual(
  2,
  Effect.fn("ContentSource.read")(function* (
    self: ContentSource,
    file: string
  ) {
    return yield* (self as Internal).readFile(file);
  })
);
