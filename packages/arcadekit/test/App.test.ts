import { Data, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import { App, Plugin, System } from "../src/index.ts";

/** A plugin whose layer notes when it is acquired and released. */
const makeHeld = () => {
  const log: string[] = [];
  const Held = Plugin.make("app/Held", {
    layer: Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => log.push("acquired")),
        () => Effect.sync(() => log.push("released"))
      )
    ),
  });
  return { Held, log };
};

describe("an app", () => {
  it("requires no scope to be made: it has one of its own", () => {
    const { Held } = makeHeld();
    expectTypeOf(App.make(App.define({ plugins: [Held] }))).toEqualTypeOf<
      Effect.Effect<App.App<never, never>, never, never>
    >();
    // Nor hands one to a system, where what it opened on each frame would be
    // kept until the app closed.
    System.frame(
      "app/Opens",
      // @ts-expect-error a frame system has no scope
      function* () {
        yield* Effect.acquireRelease(Effect.void, () => Effect.void);
      }
    );
    System.input(
      "app/Opens",
      // @ts-expect-error an input system has no scope
      function* () {
        yield* Scope.Scope;
      }
    );
  });

  it("holds what it opened until it is closed, however soon the effect that made it ended", () => {
    const { Held, log } = makeHeld();
    // Made in a scope that closes as soon as the line has run.
    const app = Effect.runSync(
      Effect.scoped(App.make(App.define({ plugins: [Held] })))
    );
    expect(log).toEqual(["acquired"]);
    app.tick(0.1);
    Effect.runSync(app.close);
    expect(log).toEqual(["acquired", "released"]);
    // Closing it again does nothing.
    Effect.runSync(app.close);
    expect(log).toEqual(["acquired", "released"]);
  });

  it("lets go at once of what it opened when the making fails", async () => {
    class Broken extends Data.TaggedError("app/Broken")<{}> {}
    const { Held, log } = makeHeld();
    const Fails = Plugin.make("app/Fails", {
      plugins: [Held],
      setup: Effect.fail(new Broken()),
    });
    expect(
      Effect.runSyncExit(App.make(App.define({ plugins: [Fails] })))
    ).toEqual(Exit.fail(new Broken()));
    expect(log).toEqual(["acquired", "released"]);
    // And when it is interrupted while it is being made.
    const Waits = Plugin.make("app/Waits", {
      plugins: [Held],
      layer: Layer.effectDiscard(Effect.never),
    });
    log.length = 0;
    const fiber = Effect.runFork(App.make(App.define({ plugins: [Waits] })));
    expect(log).toEqual(["acquired"]);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(log).toEqual(["acquired", "released"]);
  });
});
