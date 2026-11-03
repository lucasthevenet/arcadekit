import { Data, Effect, Schema } from "effect";

export class ContentError extends Data.TaggedError("ContentError")<{
  readonly message: string;
}> {}

/** Where content files come from. Returns the parsed (not yet validated) contents of one file. */
export type ContentSource = (
  file: string
) => Effect.Effect<unknown, ContentError>;

/** Reads JSON files over HTTP, relative to `baseUrl` (which should end with "/"). */
export const fetchJsonSource =
  (baseUrl: string): ContentSource =>
  (file) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${baseUrl}${file}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as unknown;
      },
      catch: (cause) =>
        new ContentError({
          message: `Could not load ${file}: ${String(cause)}`,
        }),
    });

/** Serves files from memory. For tests, or content bundled into the code. */
export const memorySource =
  (files: Readonly<Record<string, unknown>>): ContentSource =>
  (file) =>
    file in files
      ? Effect.succeed(files[file])
      : Effect.fail(
          new ContentError({ message: `No content file named ${file}` })
        );

export interface LoadContentOptions<S extends Schema.Top> {
  /** Schema for the whole content object. Should be a struct: each field is loaded from its own file. */
  readonly schema: S;
  /** Which file fills each top-level field. */
  readonly files: { readonly [K in keyof S["Type"] & string]: string };
  readonly source: ContentSource;
  /** Checks the schema can't express, like ids that must point at other entries. Return one message per problem. */
  readonly validate?: (content: S["Type"]) => ReadonlyArray<string>;
}

/** Loads every file in parallel, decodes the result with the schema, then runs `validate`. */
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
 * Use it to implement a game's own content service:
 *
 * ```ts
 * class MyContent extends Context.Service<MyContent, ContentLoader<MyGameContent>>()('my-game/Content') {}
 * const MyContentLayer = Layer.effect(MyContent, makeContentLoader({ schema, files, source }))
 * ```
 */
export const makeContentLoader = <S extends Schema.Top>(
  options: LoadContentOptions<S> & {
    readonly schema: S & { readonly DecodingServices: never };
  }
): Effect.Effect<ContentLoader<S["Type"]>> =>
  Effect.map(Effect.cached(loadContent(options)), (load) => ({ load }));
