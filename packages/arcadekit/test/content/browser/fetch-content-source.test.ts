import { Deferred, Effect, Fiber, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FetchContentSource } from "../../../src/content/browser/index";
import { Content, ContentSource } from "../../../src/content/index";

/** A stand-in for `fetch` that answers from `files` by URL, a 404 for any other, and counts. */
const serve = (files: Readonly<Record<string, string>>) => {
  const asked: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    asked.push(url);
    return Promise.resolve(
      Object.hasOwn(files, url)
        ? new Response(files[url], { status: 200 })
        : new Response("Not found", { status: 404 })
    );
  });
  return asked;
};

/** What a read of `file` failed with. */
const failureOf = (source: ContentSource.ContentSource, file: string) =>
  Effect.runPromise(Effect.flip(ContentSource.read(source, file)));

describe("a fetch content source", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches each file from its base URL, when it is read, and parses it as JSON", async () => {
    const asked = serve({ "/content/levels.json": '[{ "id": "one" }]' });
    const source = FetchContentSource.fromUrl("/content/");
    expect(asked).toStrictEqual([]);
    const levels = await Effect.runPromise(
      ContentSource.read(source, "levels.json")
    );
    expect({ levels, asked }).toStrictEqual({
      levels: [{ id: "one" }],
      asked: ["/content/levels.json"],
    });
  });

  it("fails with a ContentError naming the file and the status of a response that isn't a success", async () => {
    serve({});
    const error = await failureOf(
      FetchContentSource.fromUrl("/content/"),
      "levels.json"
    );
    expect(error).toStrictEqual(
      new ContentSource.ContentError({
        message: "Could not load levels.json: HTTP 404",
      })
    );
  });

  it("fails with a ContentError that keeps what a failed request threw", async () => {
    const thrown = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", () => Promise.reject(thrown));
    const error = await failureOf(
      FetchContentSource.fromUrl("/content/"),
      "levels.json"
    );
    expect(error).toStrictEqual(
      new ContentSource.ContentError({
        message: "Could not load levels.json: TypeError: Failed to fetch",
        cause: thrown,
      })
    );
  });

  it("fails with a ContentError for a body that isn't JSON", async () => {
    serve({ "/content/levels.json": "[{ id: one" });
    const error = await failureOf(
      FetchContentSource.fromUrl("/content/"),
      "levels.json"
    );
    expect({
      message: error.message.startsWith(
        "Could not read levels.json as JSON: SyntaxError"
      ),
      cause: error.cause instanceof SyntaxError,
    }).toStrictEqual({ message: true, cause: true });
  });

  it("aborts the request of a read that is interrupted while it waits", async () => {
    const aborted = await Effect.runPromise(
      Effect.gen(function* () {
        const asked = yield* Deferred.make<AbortSignal>();
        vi.stubGlobal(
          "fetch",
          (_url: string, init: { readonly signal: AbortSignal }) => {
            Deferred.doneUnsafe(asked, Effect.succeed(init.signal));
            // A request that hangs until it is aborted, as fetch's does.
            // oxlint-disable-next-line promise/avoid-new -- fetch's own promise, which rejects when its signal aborts.
            return new Promise<never>((_resolve, reject) => {
              init.signal.addEventListener("abort", () => {
                reject(init.signal.reason);
              });
            });
          }
        );
        const read = yield* Effect.forkChild(
          ContentSource.read(
            FetchContentSource.fromUrl("/content/"),
            "levels.json"
          )
        );
        const signal = yield* Deferred.await(asked);
        const before = signal.aborted;
        yield* Fiber.interrupt(read);
        return [before, signal.aborted];
      })
    );
    expect(aborted).toStrictEqual([false, true]);
  });

  it("gives a declaration's layer its files, each fetched once for the app", async () => {
    const asked = serve({
      "/content/levels.json": '[{ "id": "one" }]',
      "/content/title.json": '"Demo"',
    });
    class Fetched extends Content("Fetched", {
      schema: Schema.Struct({
        levels: Schema.Array(Schema.Struct({ id: Schema.String })),
        title: Schema.String,
      }),
      files: { levels: "levels.json", title: "title.json" },
    }) {}
    const [first, second] = await Effect.runPromise(
      Effect.all([Fetched.load, Fetched.load]).pipe(
        Effect.provide(Fetched.layer(FetchContentSource.fromUrl("/content/")))
      )
    );
    expect({
      first,
      same: second === first,
      asked: asked.toSorted(),
    }).toStrictEqual({
      first: { levels: [{ id: "one" }], title: "Demo" },
      same: true,
      asked: ["/content/levels.json", "/content/title.json"],
    });
  });
});
