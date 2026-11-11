import {
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
  Scope,
} from "effect";
import { describe, expect, it } from "vitest";

import { Asset, Content, ContentError, memorySource } from "./index";
import type { ContentSource } from "./index";

class SheetMissing extends Data.TaggedError("SheetMissing")<{
  readonly url: string;
}> {}

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
        return [failed, Exit.isSuccess(loaded)] as const;
      }).pipe(Effect.provide(GameSheet.layer(load)))
    );
    expect(exits).toStrictEqual([
      Exit.fail(new SheetMissing({ url: "sheet.json" })),
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
  const inner = memorySource(files);
  const source: ContentSource = (file) => {
    state.reads += 1;
    return inner(file);
  };
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
          GameContent.read(memorySource({ ...good, "title.json": 7 }))
        ),
        Effect.exit(
          GameContent.read(memorySource({ ...good, "levels.json": [] }))
        ),
      ])
    );
    expect(JSON.stringify(exits[0])).toContain("Invalid content");
    expect(exits[1]).toStrictEqual(
      Exit.fail(
        new ContentError({
          message: "Content problems: levels.json has no levels",
        })
      )
    );
  });

  it("fails with the source's ContentError for a file it doesn't have", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        GameContent.read(memorySource({ "levels.json": [{ id: "one" }] }))
      )
    );
    expect(exit).toStrictEqual(
      Exit.fail(
        new ContentError({ message: "No content file named title.json" })
      )
    );
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
        Effect.provide(GameContent.layer((file) => memorySource(files)(file)))
      )
    );
    expect(outcomes).toStrictEqual([true, true]);
  });

  it("reads straight from a source, for a test of a game's real files", async () => {
    const content = await Effect.runPromise(
      GameContent.read(memorySource(good))
    );
    expect(content.levels.map((level) => level.id)).toStrictEqual(["one"]);
  });

  it("provides one content per layer", async () => {
    const titles = await Effect.runPromise(
      Effect.all(
        ["Demo", "Other"].map((title) =>
          GameContent.load.pipe(
            Effect.map((content) => content.title),
            Effect.provide(
              GameContent.layer(memorySource({ ...good, "title.json": title }))
            )
          )
        )
      )
    );
    expect(titles).toStrictEqual(["Demo", "Other"]);
    // A layer value is reused when provided twice in one program: this is two layers.
    expect(Layer.isLayer(GameContent.layer(memorySource(good)))).toBe(true);
  });
});
