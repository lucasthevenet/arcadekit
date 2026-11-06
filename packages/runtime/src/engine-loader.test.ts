import { Data, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { makeEngineLoader } from "./browser";
import type { GameDefinition } from "./browser";
import { manualFrames } from "./testing";

// makeEngineLoader with fake assets and a game that does nothing. No DOM: nothing attaches.

class AssetsError extends Data.TaggedError("AssetsError")<{
  readonly attempt: number;
}> {}

interface Assets {
  readonly id: number;
}

const game = (): GameDefinition<null, null, null, never> => ({
  create: () => null,
  step: () => {},
  drainEvents: () => [],
  sample: { everyMs: 1000, read: () => undefined as never },
  createInput: () => ({ read: () => null, dispose: () => {} }),
  createView: () => ({ render: () => {}, dispose: () => {} }),
});

/**
 * A loader whose `assets` runs `attempt(n)` on its n-th run (from 1), counting runs, games
 * made and releases.
 */
const counted = (
  attempt: (n: number) => Effect.Effect<Assets, AssetsError>
) => {
  const counts = { assets: 0, games: 0, released: [] as number[] };
  const loader = makeEngineLoader({
    assets: Effect.suspend(() => {
      counts.assets += 1;
      return attempt(counts.assets);
    }),
    game: () => {
      counts.games += 1;
      return game();
    },
    release: (assets) => {
      counts.released.push(assets.id);
    },
    frames: manualFrames(),
  });
  return { counts, loader };
};

describe(makeEngineLoader, () => {
  it("loads once and makes one engine, shared by concurrent and later callers", async () => {
    const { counts, loader } = counted((n) =>
      Effect.sleep("5 millis").pipe(Effect.as({ id: n }))
    );
    const [first, second, later] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { load } = yield* loader;
          const [a, b] = yield* Effect.all([load, load], {
            concurrency: "unbounded",
          });
          return [a, b, yield* load] as const;
        })
      )
    );
    expect(second.engine).toBe(first.engine);
    expect(later.engine).toBe(first.engine);
    expect(first.assets).toStrictEqual({ id: 1 });
    expect({ assets: counts.assets, games: counts.games }).toStrictEqual({
      assets: 1,
      games: 1,
    });
  });

  it("doesn't keep a failure, so the next load retries, and makes no game for it", async () => {
    const { counts, loader } = counted((n) =>
      n === 1
        ? Effect.fail(new AssetsError({ attempt: n }))
        : Effect.succeed({ id: n })
    );
    const [failed, gamesAfterFailure, retried] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { load } = yield* loader;
          const first = yield* Effect.flip(load);
          const { games } = counts;
          return [first, games, yield* load] as const;
        })
      )
    );
    expect(failed).toStrictEqual(new AssetsError({ attempt: 1 }));
    expect(gamesAfterFailure).toBe(0);
    expect(retried.assets).toStrictEqual({ id: 2 });
    expect({ assets: counts.assets, games: counts.games }).toStrictEqual({
      assets: 2,
      games: 1,
    });
  });

  it("never makes a game while every load fails", async () => {
    const { counts, loader } = counted((n) =>
      Effect.fail(new AssetsError({ attempt: n }))
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { load } = yield* loader;
          yield* Effect.flip(load);
          yield* Effect.flip(load);
        })
      )
    );
    expect({ assets: counts.assets, games: counts.games }).toStrictEqual({
      assets: 2,
      games: 0,
    });
  });

  it("releases the kept assets once, when its scope closes", async () => {
    const { counts, loader } = counted((n) => Effect.succeed({ id: n }));
    const releasedBeforeClose = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { load } = yield* loader;
          yield* load;
          yield* load;
          return [...counts.released];
        })
      )
    );
    expect(releasedBeforeClose).toStrictEqual([]);
    expect(counts.released).toStrictEqual([1]);
  });

  it("releases the assets of a load whose game throws, and keeps only the retry's", async () => {
    const counts = { games: 0, released: [] as number[] };
    let next = 0;
    const loader = makeEngineLoader({
      assets: Effect.sync((): Assets => {
        next += 1;
        return { id: next };
      }),
      game: () => {
        counts.games += 1;
        if (counts.games === 1) {
          throw new Error("no game");
        }
        return game();
      },
      release: (assets) => {
        counts.released.push(assets.id);
      },
      frames: manualFrames(),
    });
    const [releasedAfterThrow, retried] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { load } = yield* loader;
          const first = yield* Effect.exit(load);
          expect(Exit.hasDies(first)).toBe(true);
          const released = [...counts.released];
          return [released, yield* load] as const;
        })
      )
    );
    expect(releasedAfterThrow).toStrictEqual([1]);
    expect(retried.assets).toStrictEqual({ id: 2 });
    expect(counts.released).toStrictEqual([1, 2]);
  });

  it("releases nothing when every load failed", async () => {
    const { counts, loader } = counted((n) =>
      Effect.fail(new AssetsError({ attempt: n }))
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.flip((yield* loader).load);
        })
      )
    );
    expect(counts.released).toStrictEqual([]);
  });

  it("doesn't keep a load its only caller abandoned: the next load starts afresh", async () => {
    const started = Effect.runSync(Deferred.make<boolean>());
    const { counts, loader } = counted((n) =>
      n === 1
        ? Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never))
        : Effect.succeed({ id: n })
    );
    const scope = Effect.runSync(Scope.make());
    const { load } = await Effect.runPromise(Scope.provide(loader, scope));
    const loaded = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(load);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        return yield* load;
      })
    );
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(loaded.assets).toStrictEqual({ id: 2 });
    expect({ assets: counts.assets, released: counts.released }).toStrictEqual({
      assets: 2,
      released: [2],
    });
  });

  it("releases assets a load finishes after its scope closed", async () => {
    const started = Effect.runSync(Deferred.make<boolean>());
    const finish = Effect.runSync(Deferred.make<boolean>());
    const { counts, loader } = counted((n) =>
      Deferred.succeed(started, true).pipe(
        Effect.andThen(Deferred.await(finish)),
        Effect.as({ id: n })
      )
    );
    const scope = Effect.runSync(Scope.make());
    const { load } = await Effect.runPromise(Scope.provide(loader, scope));
    // The caller isn't in the loader's scope, so closing the scope doesn't end its load.
    const loaded = Effect.runPromise(load);
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Scope.close(scope, Exit.void));
    const releasedAtClose = [...counts.released];
    await Effect.runPromise(Deferred.succeed(finish, true));
    await loaded;
    expect({ releasedAtClose, released: counts.released }).toStrictEqual({
      releasedAtClose: [],
      released: [1],
    });
  });
});
