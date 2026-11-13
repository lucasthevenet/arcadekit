import { Effect, Exit, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import { Content, ContentSource } from "./index";

/** A read of a file, as a source is made from: here, its name. */
const readName = (file: string) => Effect.succeed(file);

describe("a content source", () => {
  it("is recognised by its guard, and a look-alike is not", () => {
    const source = ContentSource.fromRecord({});
    expect([
      ContentSource.isContentSource(source),
      ContentSource.isContentSource(ContentSource.make(readName)),
      ContentSource.isContentSource(readName),
      ContentSource.isContentSource({ readFile: readName }),
      ContentSource.isContentSource(null),
    ]).toStrictEqual([true, true, false, false, false]);
  });

  it("prints as a content source, not as the function it reads with", () => {
    const source = ContentSource.fromRecord({ "levels.json": [] });
    expect(source.toJSON()).toStrictEqual({ _id: "ContentSource" });
    expect(JSON.parse(String(source))).toStrictEqual({ _id: "ContentSource" });
  });

  it("reads a file when the read runs, each time, and not when it is made", () => {
    const asked: string[] = [];
    const source = ContentSource.make((file) => {
      asked.push(file);
      return Effect.succeed(file.length);
    });
    const read = ContentSource.read(source, "levels.json");
    expect(asked).toStrictEqual([]);
    expect([Effect.runSync(read), Effect.runSync(read)]).toStrictEqual([
      11, 11,
    ]);
    expect(asked).toStrictEqual(["levels.json", "levels.json"]);
  });

  it("reads the same, data first or piped", () => {
    const source = ContentSource.fromRecord({ "title.json": "Demo" });
    expect([
      Effect.runSync(ContentSource.read(source, "title.json")),
      Effect.runSync(source.pipe(ContentSource.read("title.json"))),
    ]).toStrictEqual(["Demo", "Demo"]);
  });

  it("serves a record's own files, and names a file it doesn't have", () => {
    const source = ContentSource.fromRecord({ "levels.json": [{ id: "one" }] });
    const missing = (file: string) =>
      Effect.runSync(Effect.flip(ContentSource.read(source, file)));
    expect(
      Effect.runSync(ContentSource.read(source, "levels.json"))
    ).toStrictEqual([{ id: "one" }]);
    // A key every object has from its prototype is no file.
    expect([missing("heroes.json"), missing("constructor")]).toStrictEqual([
      new ContentSource.ContentError({
        message: "No content file named heroes.json",
      }),
      new ContentSource.ContentError({
        message: "No content file named constructor",
      }),
    ]);
  });

  it("reads under a span of its own", () => {
    const source = ContentSource.make(() =>
      Effect.currentSpan.pipe(
        Effect.orDie,
        Effect.map((span) => span.name)
      )
    );
    expect(Effect.runSync(ContentSource.read(source, "levels.json"))).toBe(
      "ContentSource.read"
    );
  });

  it("is what a declaration's layer and read take, and a function is not", () => {
    class Titled extends Content("Titled", {
      schema: Schema.Struct({ title: Schema.String }),
      files: { title: "title.json" },
    }) {}
    expectTypeOf(Titled.layer)
      .parameter(0)
      .toEqualTypeOf<ContentSource.ContentSource>();
    // @ts-expect-error -- a source is made with ContentSource.make, not written as a function.
    Titled.read((file: string) => Effect.succeed(file));
    expectTypeOf(ContentSource.read("title.json")).toEqualTypeOf<
      (
        self: ContentSource.ContentSource
      ) => Effect.Effect<unknown, ContentSource.ContentError>
    >();
  });
});

describe("a content error", () => {
  it("is a tagged error an app catches by its tag", () => {
    const source = ContentSource.fromRecord({});
    const caught = Effect.runSync(
      ContentSource.read(source, "levels.json").pipe(
        Effect.catchTag("ContentError", (error) =>
          Effect.succeed(error.message)
        )
      )
    );
    expect(caught).toBe("No content file named levels.json");
  });

  it("keeps what a source threw as its cause, and has no cause otherwise", () => {
    const thrown = new SyntaxError("Unexpected end of JSON input");
    const error = new ContentSource.ContentError({
      message: "Could not read levels.json",
      cause: thrown,
    });
    expect({
      tag: error._tag,
      message: error.message,
      cause: error.cause,
      isError: error instanceof Error,
    }).toStrictEqual({
      tag: "ContentError",
      message: "Could not read levels.json",
      cause: thrown,
      isError: true,
    });
    expect(
      Object.hasOwn(new ContentSource.ContentError({ message: "m" }), "cause")
    ).toBe(false);
  });

  it("is a Schema: its fields are checked", () => {
    expect(
      Schema.is(ContentSource.ContentError)(
        new ContentSource.ContentError({ message: "m" })
      )
    ).toBe(true);
    expect(
      Exit.isFailure(
        Effect.runSyncExit(
          Effect.try(
            () =>
              new ContentSource.ContentError({
                // @ts-expect-error -- a message is a string.
                message: 7,
              })
          )
        )
      )
    ).toBe(true);
  });
});
