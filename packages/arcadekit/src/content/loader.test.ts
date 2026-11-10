import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { loadContent, makeContentLoader, memorySource } from "./index";

const Content = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ id: Schema.String, next: Schema.String })
  ),
  title: Schema.String,
});

const files = { items: "items.json", title: "title.json" } as const;

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromiseExit(effect);

describe(loadContent, () => {
  it("loads each field from its file and decodes it", async () => {
    const source = memorySource({
      "items.json": [{ id: "a", next: "a" }],
      "title.json": "Demo",
    });
    const exit = await run(loadContent({ schema: Content, files, source }));
    expect(exit).toStrictEqual(
      Exit.succeed({ items: [{ id: "a", next: "a" }], title: "Demo" })
    );
  });

  it("fails with a ContentError on a schema mismatch", async () => {
    const source = memorySource({
      "items.json": [{ id: 1 }],
      "title.json": "Demo",
    });
    const exit = await run(loadContent({ schema: Content, files, source }));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("Invalid content");
  });

  it("fails when validate reports problems", async () => {
    const source = memorySource({
      "items.json": [{ id: "a", next: "missing" }],
      "title.json": "Demo",
    });
    const validate = (c: typeof Content.Type) =>
      c.items
        .filter((i) => !c.items.some((j) => j.id === i.next))
        .map((i) => `${i.id} points at ${i.next}`);
    const exit = await run(
      loadContent({ schema: Content, files, source, validate })
    );
    expect(JSON.stringify(exit)).toContain("a points at missing");
  });

  it("fails when a file is missing", async () => {
    const exit = await run(
      loadContent({ schema: Content, files, source: memorySource({}) })
    );
    expect(JSON.stringify(exit)).toContain("No content file named");
  });
});

describe(makeContentLoader, () => {
  it("reads the files only once", async () => {
    let reads = 0;
    const inner = memorySource({ "items.json": [], "title.json": "Demo" });
    const source = (file: string) =>
      Effect.suspend(() => {
        reads += 1;
        return inner(file);
      });
    const loader = await Effect.runPromise(
      makeContentLoader({ schema: Content, files, source })
    );
    await Effect.runPromise(loader.load);
    await Effect.runPromise(loader.load);
    // Two files, read once each.
    expect(reads).toBe(2);
  });

  it("reads the files again after a failed load, then keeps the success", async () => {
    let reads = 0;
    const inner = memorySource({ "items.json": [], "title.json": "Demo" });
    // The first read fails, like a network blip; every later read succeeds.
    const source = (file: string) =>
      Effect.suspend(() => {
        reads += 1;
        return reads === 1 ? memorySource({})(file) : inner(file);
      });
    const loader = await Effect.runPromise(
      makeContentLoader({ schema: Content, files, source })
    );
    expect(Exit.isFailure(await run(loader.load))).toBe(true);
    expect(Exit.isSuccess(await run(loader.load))).toBe(true);
    const readsAfterSuccess = reads;
    expect(Exit.isSuccess(await run(loader.load))).toBe(true);
    expect(reads).toBe(readsAfterSuccess);
  });
});
