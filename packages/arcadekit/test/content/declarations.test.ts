import {
  Cause,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Scope,
} from "effect";
import type { Tracer } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import { Asset, Content, ContentSource } from "../../src/content/index";

/**
 * What a failed exit failed with: each reason of its cause, a failure as its error. A load and a
 * read are traced, so their failures carry their spans as annotations, which this leaves out. A
 * success is "succeeded", which no expected list equals.
 */
const failures = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? "succeeded"
    : exit.cause.reasons.map((reason) =>
        Cause.isFailReason(reason) ? reason.error : reason
      );

class SheetMissing extends Data.TaggedError("SheetMissing")<{
  readonly url: string;
}> {}

/** The names of a span and of every span above it, the innermost first. */
const spanNames = (span: Tracer.AnySpan): readonly string[] =>
  span._tag === "Span"
    ? [
        span.name,
        ...Option.match(span.parent, { onNone: () => [], onSome: spanNames }),
      ]
    : [];

/** A sheet as a test sees it: its url, and whether it was freed. */
interface Sheet {
  readonly url: string;
  freed: boolean;
}

class GameSheet extends Asset<Sheet, SheetMissing>()("GameSheet", {
  release: (sheet) => {
    sheet.freed = true;
  },
}) {}

/** A load a test counts, and can make fail. */
const countedLoad = () => {
  const loads: Sheet[] = [];
  const state = { failing: false, attempts: 0 };
  const load = Effect.suspend(() => {
    state.attempts += 1;
    if (state.failing) {
      return Effect.fail(new SheetMissing({ url: "sheet.json" }));
    }
    const sheet: Sheet = { url: "sheet.json", freed: false };
    loads.push(sheet);
    return Effect.succeed(sheet);
  });
  return { load, loads, state };
};

describe(Asset, () => {
  it("loads nothing until it is asked, then loads once and gives the same asset", async () => {
    const { load, loads, state } = countedLoad();
    const [first, second] = await Effect.runPromise(
      Effect.gen(function* () {
        expect(state.attempts).toBe(0);
        return [yield* GameSheet.load, yield* GameSheet.load] as const;
      }).pipe(Effect.provide(GameSheet.layer(load)))
    );
    expect(state.attempts).toBe(1);
    expect(first).toBe(second);
    expect(first).toBe(loads[0]);
  });

  it("frees the asset when the layer's scope closes, and not before", async () => {
    const { load, loads } = countedLoad();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* GameSheet.load;
        expect(loads[0]?.freed).toBe(false);
      }).pipe(Effect.provide(GameSheet.layer(load)))
    );
    expect(loads[0]?.freed).toBe(true);
  });

  it("fails with the load's error, keeps no failure, and loads again when asked again", async () => {
    const { load, state } = countedLoad();
    state.failing = true;
    const exits = await Effect.runPromise(
      Effect.gen(function* () {
        const failed = yield* Effect.exit(GameSheet.load);
        state.failing = false;
        const loaded = yield* Effect.exit(GameSheet.load);
        return [failures(failed), Exit.isSuccess(loaded)] as const;
      }).pipe(Effect.provide(GameSheet.layer(load)))
    );
    expect(exits).toStrictEqual([
      [new SheetMissing({ url: "sheet.json" })],
      true,
    ]);
    expect(state.attempts).toBe(2);
  });

  it("shares one load between callers that ask at the same time", async () => {
    const { load, state } = countedLoad();
    const slow = Effect.andThen(Effect.sleep("10 millis"), load);
    await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* Effect.forkChild(GameSheet.load);
        const b = yield* Effect.forkChild(GameSheet.load);
        expect(yield* Fiber.join(a)).toBe(yield* Fiber.join(b));
      }).pipe(Effect.provide(GameSheet.layer(slow)))
    );
    expect(state.attempts).toBe(1);
  });

  it("doesn't keep a load its only caller abandoned: the next load starts afresh", async () => {
    const { loads, state } = countedLoad();
    const sheet: Sheet = { url: "second.json", freed: false };
    const loaded = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<boolean>();
        // The first load never finishes; the one after it does.
        const load = Effect.suspend(() => {
          state.attempts += 1;
          return state.attempts === 1
            ? Effect.andThen(Deferred.succeed(started, true), Effect.never)
            : Effect.succeed(sheet);
        });
        return yield* Effect.gen(function* () {
          const caller = yield* Effect.forkChild(GameSheet.load);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(caller);
          return yield* GameSheet.load;
        }).pipe(Effect.provide(GameSheet.layer(load)));
      })
    );
    expect(loaded).toBe(sheet);
    expect({ attempts: state.attempts, kept: loads.length }).toStrictEqual({
      attempts: 2,
      kept: 0,
    });
    // The layer's scope closed with the asset the second load gave: that one is freed.
    expect(sheet.freed).toBe(true);
  });

  it("frees an asset whose load finishes after the layer's scope closed", async () => {
    const sheet: Sheet = { url: "late.json", freed: false };
    const freedAtClose = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<boolean>();
        const finish = yield* Deferred.make<boolean>();
        const load = Deferred.succeed(started, true).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.as(sheet)
        );
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(
          GameSheet.layer(load),
          scope
        );
        // The caller isn't in the layer's scope, so closing the scope doesn't end its load.
        const caller = yield* Effect.forkChild(
          Effect.provide(GameSheet.load, context)
        );
        yield* Deferred.await(started);
        yield* Scope.close(scope, Exit.void);
        const atClose = sheet.freed;
        yield* Deferred.succeed(finish, true);
        yield* Fiber.join(caller);
        return atClose;
      })
    );
    expect({ freedAtClose, freed: sheet.freed }).toStrictEqual({
      freedAtClose: false,
      freed: true,
    });
  });

  it("traces each load under the declared name, through the class or the key", () => {
    const traced = Effect.currentSpan.pipe(
      Effect.orDie,
      Effect.map((span): Sheet => ({
        url: spanNames(span).join(" < "),
        freed: false,
      }))
    );
    const urls = Effect.runSync(
      Effect.gen(function* () {
        const byClass = yield* GameSheet.load;
        const byKey = yield* (yield* GameSheet).load;
        return [byClass.url, byKey === byClass];
      }).pipe(Effect.provide(GameSheet.layer(traced)))
    );
    expect(urls).toStrictEqual(["GameSheet.load", true]);
  });

  it("frees only the asset it kept: a failed load has nothing to free", async () => {
    const { load, loads, state } = countedLoad();
    state.failing = true;
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.exit(GameSheet.load);
        yield* Effect.exit(GameSheet.load);
        state.failing = false;
        yield* GameSheet.load;
        yield* GameSheet.load;
      }).pipe(Effect.provide(GameSheet.layer(load)))
    );
    expect({
      attempts: state.attempts,
      freed: loads.map((sheet) => sheet.freed),
    }).toStrictEqual({ attempts: 3, freed: [true] });
  });

  it("is reached through its key as well", async () => {
    const { load } = countedLoad();
    const url = await Effect.runPromise(
      Effect.gen(function* () {
        const sheet = yield* (yield* GameSheet).load;
        return sheet.url;
      }).pipe(Effect.provide(GameSheet.layer(load)))
    );
    expect(url).toBe("sheet.json");
  });
});

const Levels = Schema.Struct({
  levels: Schema.Array(Schema.Struct({ id: Schema.String })),
  title: Schema.String,
});

class GameContent extends Content("GameContent", {
  schema: Levels,
  files: { levels: "levels.json", title: "title.json" },
  validate: (content) =>
    content.levels.length === 0 ? ["levels.json has no levels"] : [],
}) {}

const good = { "levels.json": [{ id: "one" }], "title.json": "Demo" };

/** A source that counts the files it serves. */
const counted = (files: Readonly<Record<string, unknown>>) => {
  const state = { reads: 0 };
  const inner = ContentSource.fromRecord(files);
  const source = ContentSource.make((file) => {
    state.reads += 1;
    return ContentSource.read(inner, file);
  });
  return { source, state };
};

describe(Content, () => {
  it("loads each part from its file, checks it, and keeps the first success", async () => {
    const { source, state } = counted(good);
    const [first, second] = await Effect.runPromise(
      Effect.gen(function* () {
        expect(state.reads).toBe(0);
        return [yield* GameContent.load, yield* GameContent.load] as const;
      }).pipe(Effect.provide(GameContent.layer(source)))
    );
    expect(first).toStrictEqual({ levels: [{ id: "one" }], title: "Demo" });
    expect(second).toBe(first);
    // One read of each file.
    expect(state.reads).toBe(2);
  });

  it("fails with a ContentError for what the Schema or `validate` refuses", async () => {
    const exits = await Effect.runPromise(
      Effect.all([
        Effect.exit(
          GameContent.read(
            ContentSource.fromRecord({ ...good, "title.json": 7 })
          )
        ),
        Effect.exit(
          GameContent.read(
            ContentSource.fromRecord({ ...good, "levels.json": [] })
          )
        ),
      ])
    );
    expect(JSON.stringify(exits[0])).toContain("Invalid content");
    expect(failures(exits[1])).toStrictEqual([
      new ContentSource.ContentError({
        message: "Content problems: levels.json has no levels",
      }),
    ]);
  });

  it("fails with the source's ContentError for a file it doesn't have", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        GameContent.read(
          ContentSource.fromRecord({ "levels.json": [{ id: "one" }] })
        )
      )
    );
    expect(failures(exit)).toStrictEqual([
      new ContentSource.ContentError({
        message: "No content file named title.json",
      }),
    ]);
  });

  it("keeps no failure: a load that failed runs again", async () => {
    const files: Record<string, unknown> = { "title.json": "Demo" };
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const failed = yield* Effect.exit(GameContent.load);
        files["levels.json"] = [{ id: "one" }];
        const loaded = yield* Effect.exit(GameContent.load);
        return [Exit.isFailure(failed), Exit.isSuccess(loaded)];
      }).pipe(
        Effect.provide(
          GameContent.layer(
            ContentSource.make((file) =>
              ContentSource.read(ContentSource.fromRecord(files), file)
            )
          )
        )
      )
    );
    expect(outcomes).toStrictEqual([true, true]);
  });

  it("reads straight from a source, for a test of a game's real files", async () => {
    const content = await Effect.runPromise(
      GameContent.read(ContentSource.fromRecord(good))
    );
    expect(content.levels.map((level) => level.id)).toStrictEqual(["one"]);
  });

  it("traces each load under the declared name, and each read of its files under the load", () => {
    class Traced extends Content("Traced", {
      schema: Schema.Struct({ spans: Schema.Array(Schema.String) }),
      files: { spans: "spans.json" },
    }) {}
    const source = ContentSource.make(() =>
      Effect.currentSpan.pipe(Effect.orDie, Effect.map(spanNames))
    );
    const [loaded, read] = Effect.runSync(
      Effect.all([Traced.load, Traced.read(source)]).pipe(
        Effect.provide(Traced.layer(source))
      )
    );
    expect([loaded.spans, read.spans]).toStrictEqual([
      ["ContentSource.read", "Traced.read", "Traced.load"],
      ["ContentSource.read", "Traced.read"],
    ]);
  });

  it("types its load by its Schema and its class, and fails it with a ContentError", () => {
    expectTypeOf(GameContent.load).toEqualTypeOf<
      Effect.Effect<
        {
          readonly levels: readonly { readonly id: string }[];
          readonly title: string;
        },
        ContentSource.ContentError,
        GameContent
      >
    >();
    expectTypeOf(
      GameContent.layer(ContentSource.fromRecord(good))
    ).toEqualTypeOf<Layer.Layer<GameContent>>();
    // oxlint-disable-next-line declaration/class -- a test of what the builder refuses.
    Content("Misfiled", {
      schema: Schema.Struct({ title: Schema.String }),
      // @ts-expect-error -- each field of the Schema names its file.
      files: { heading: "title.json" },
    });
  });

  it("provides one content per layer", async () => {
    const titles = await Effect.runPromise(
      Effect.all(
        ["Demo", "Other"].map((title) =>
          GameContent.load.pipe(
            Effect.map((content) => content.title),
            Effect.provide(
              GameContent.layer(
                ContentSource.fromRecord({ ...good, "title.json": title })
              )
            )
          )
        )
      )
    );
    expect(titles).toStrictEqual(["Demo", "Other"]);
    // A layer value is reused when provided twice in one program: this is two layers.
    expect(
      Layer.isLayer(GameContent.layer(ContentSource.fromRecord(good)))
    ).toBe(true);
  });
});
