import { Data, Effect, Schema } from "effect";

// Named so the type files can be made one file at a time (isolatedDeclarations).
const ContentErrorBase: ReturnType<typeof Data.TaggedError<"ContentError">> =
  Data.TaggedError("ContentError");

/**
 * The error every content source and every load of content fails with.
 * Apps catch it by its tag: `Effect.catchTag("ContentError", ...)`.
 */
export class ContentError extends ContentErrorBase<{
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
 * What `Content` takes: a genre's schema, the file each part comes from, and the checks the
 * schema can't express. The genre's content service and its tests load the same definition,
 * each with its own source, so they run the same checks.
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

/**
 * Loads every file of `definition` from `source` in parallel, decodes the result with the
 * schema, then runs `validate`. It is what a `Content` declaration loads with, and no entry
 * exports it: the class's `read(source)` is this call, and its service keeps the first
 * successful result.
 */
export const loadContent = <S extends Schema.Top>(
  definition: ContentDefinition<S>,
  source: ContentSource
): Effect.Effect<S["Type"], ContentError, S["DecodingServices"]> =>
  Effect.gen(function* () {
    const raw = yield* Effect.all(
      Object.fromEntries(
        Object.entries<string>(definition.files).map(([field, file]) => [
          field,
          source(file),
        ])
      ),
      { concurrency: "unbounded" }
    );
    const content = yield* Schema.decodeUnknownEffect(definition.schema)(
      raw
    ).pipe(
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
