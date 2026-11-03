import { Data, Effect, Schema } from "effect";

/**
 * The error every content source and loader fails with.
 * Apps catch it by its tag: `Effect.catchTag("ContentError", ...)`.
 */
export class ContentError extends Data.TaggedError("ContentError")<{
  readonly message: string;
}> {}

/** Where content files come from. Returns the parsed (not yet validated) contents of one file. */
export type ContentSource = (
  file: string
) => Effect.Effect<unknown, ContentError>;

/** Serves files from memory. For tests, or content bundled into the code. */
export const memorySource =
  (files: Readonly<Record<string, unknown>>): ContentSource =>
  (file) =>
    file in files
      ? Effect.succeed(files[file])
      : Effect.fail(
          new ContentError({ message: `No content file named ${file}` })
        );

/**
 * A genre's schema, the file each part comes from, and the checks the schema can't express,
 * as one value. The genre's content service and its tests load the same definition, each
 * with its own source, so they run the same checks.
 */
export interface ContentDefinition<S extends Schema.Top> {
  /** Schema for the whole content object. Should be a struct: each field is loaded from its own file. */
  readonly schema: S;
  /** Which file fills each top-level field. */
  // oxlint-disable-next-line typescript/consistent-indexed-object-style -- a mapped type keeps the schema's per-field modifiers; Record drops them.
  readonly files: { readonly [K in keyof S["Type"] & string]: string };
  /** Checks the schema can't express, like ids that must point at other entries. Return one message per problem. */
  readonly validate?: (content: S["Type"]) => readonly string[];
}

/** A content definition and the source its files come from. */
export interface LoadContentOptions<
  S extends Schema.Top,
> extends ContentDefinition<S> {
  readonly source: ContentSource;
}

/**
 * Loads every file in parallel, decodes the result with the schema, then runs `validate`.
 * Call it to load and check content directly, for example in a test of a game's real
 * content files: `loadContent({ ...definition, source })` runs the genre's own checks.
 * A game's content service uses `makeContentLoader`, which caches the result.
 */
export const loadContent = <S extends Schema.Top>(
  options: LoadContentOptions<S>
): Effect.Effect<S["Type"], ContentError, S["DecodingServices"]> =>
  Effect.gen(function* () {
    const raw = yield* Effect.all(
      Object.fromEntries(
        Object.entries<string>(options.files).map(([field, file]) => [
          field,
          options.source(file),
        ])
      ),
      { concurrency: "unbounded" }
    );
    const content = yield* Schema.decodeUnknownEffect(options.schema)(raw).pipe(
      Effect.mapError(
        (error) =>
          new ContentError({ message: `Invalid content: ${error.message}` })
      )
    );
    const problems = options.validate?.(content) ?? [];
    if (problems.length > 0) {
      return yield* new ContentError({
        message: `Content problems: ${problems.join("; ")}`,
      });
    }
    return content;
  });

/** A content service shape: `load` runs once, then returns the cached result. */
export interface ContentLoader<A> {
  readonly load: Effect.Effect<A, ContentError>;
}

/**
 * Builds a ContentLoader whose `load` is cached after the first call.
 * Use it to implement a game's own content service from its content definition:
 *
 * ```ts
 * const myContentDefinition: ContentDefinition<typeof MyGameContent> = { schema: MyGameContent, files, validate }
 * class MyContent extends Context.Service<MyContent, ContentLoader<MyGameContent>>()('my-game/Content') {}
 * const MyContentLayer = Layer.effect(MyContent, makeContentLoader({ ...myContentDefinition, source }))
 * ```
 */
export const makeContentLoader = <S extends Schema.Top>(
  options: LoadContentOptions<S> & {
    readonly schema: S & { readonly DecodingServices: never };
  }
): Effect.Effect<ContentLoader<S["Type"]>> =>
  Effect.map(Effect.cached(loadContent(options)), (load) => ({ load }));
