import { SurvivorsContent } from "@arcadekit/survivors";
import type { GameContent } from "@arcadekit/survivors";
import { SurvivorsEngine } from "@arcadekit/survivors/browser";
import type { SurvivorsEngineLoader } from "@arcadekit/survivors/browser";
import { SilentAudioLayer } from "arcadekit/audio";
import type { ContentError } from "arcadekit/content";
import type { SignallingRoom } from "arcadekit/net/browser";
import { SpriteSheetError } from "arcadekit/render-three";
import { AttachError } from "arcadekit/runtime/browser";
import { manualFrames } from "arcadekit/runtime/testing";
import { Context, Deferred, Effect, Exit, Layer, Scope, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeCoopClient } from "../coop/client";
import type { CoopRooms } from "../coop/client";
import { HostCoop, LeaveCoop } from "./commands";
import { Coop, makeCoop, makeCoopLayer } from "./coop";

// makeCoopLayer and makeCoop with nothing real behind them: the rooms are fakes, nothing draws.

/** A loader whose load never finishes: building the layer loads nothing. */
const idleLoader = { load: Effect.never } as unknown as SurvivorsEngineLoader;

/** A loader that has loaded, with art nothing reads. */
const loadedLoader = {
  load: Effect.succeed({ assets: {}, engine: {} }),
} as unknown as SurvivorsEngineLoader;

/** Rooms that open at once and say nothing more; `log` records each opened and released. */
const quietRooms = (log: string[]): CoopRooms => {
  const room = (role: "host" | "guest") =>
    Effect.acquireRelease(
      Effect.sync((): SignallingRoom => {
        log.push(`open ${role}`);
        return {
          role,
          code: "K7MQ2X",
          self: role === "host" ? "host" : "guest-1",
          host: "host",
          events: Stream.never,
          links: () => [],
          start: Effect.void,
        };
      }),
      () => Effect.sync(() => log.push(`release ${role}`))
    );
  return { host: room("host"), join: () => room("guest") };
};

describe("the co-op layer", () => {
  it("leaves the room and removes its debug global when the app's scope closes", async () => {
    const log: string[] = [];
    const layer = makeCoopLayer(() => quietRooms(log)).pipe(
      Layer.provide(SilentAudioLayer),
      Layer.provide(Layer.succeed(SurvivorsEngine, idleLoader)),
      Layer.provide(
        Layer.succeed(SurvivorsContent, {
          load: Effect.succeed({ heroes: [] } as unknown as GameContent),
        })
      )
    );
    const scope = Effect.runSync(Scope.make());
    const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
    const coop = Context.get(context, Coop);
    await Effect.runPromise(coop.host("spark"));
    const whileOpen = ["arcadekitCoop" in globalThis, [...log]];
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect({
      whileOpen,
      afterClose: ["arcadekitCoop" in globalThis, log],
    }).toStrictEqual({
      whileOpen: [true, ["open host"]],
      afterClose: [false, ["open host", "release host"]],
    });
  });
});

describe("the co-op Commands", () => {
  it("open no room when Leave comes while Host waits on the content", async () => {
    const log: string[] = [];
    const loaded = Effect.runSync(Deferred.make<GameContent, ContentError>());
    const layer = makeCoopLayer(() => quietRooms(log)).pipe(
      Layer.provide(SilentAudioLayer),
      Layer.provide(Layer.succeed(SurvivorsEngine, idleLoader)),
      Layer.provide(
        Layer.succeed(SurvivorsContent, { load: Deferred.await(loaded) })
      )
    );
    const scope = Effect.runSync(Scope.make());
    const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
    // Foldkit runs each Command in Message order: Host, then Leave.
    const run = <A>(effect: Effect.Effect<A, never, Coop>) =>
      Effect.runPromise(Effect.provideContext(effect, context));
    await run(HostCoop({ heroId: "spark" }).effect);
    await run(LeaveCoop().effect);
    await Effect.runPromise(
      Deferred.succeed(loaded, { heroes: [] } as unknown as GameContent)
    );
    await Effect.runPromise(Effect.yieldNow);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(log).toStrictEqual([]);
  });
});

describe(makeCoop, () => {
  let scope: Scope.Closeable;

  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    scope = Effect.runSync(Scope.make());
  });

  afterEach(() => {
    Effect.runSync(Scope.close(scope, Exit.void));
    vi.unstubAllGlobals();
  });

  const element = Object.assign(new EventTarget(), {
    style: {},
  }) as unknown as HTMLElement;

  const client = (createView: () => never) =>
    Effect.runSync(
      Scope.provide(
        makeCoopClient({
          rooms: quietRooms([]),
          content: Effect.never,
          frames: manualFrames(),
          createView,
        }),
        scope
      )
    );

  it("fails attach with an AttachError when the client can't draw, as with no WebGL", async () => {
    const noWebGl = new Error("no WebGL");
    const coop = makeCoop(
      client(() => {
        throw noWebGl;
      }),
      loadedLoader
    );
    const error = await Effect.runPromise(Effect.flip(coop.attach(element)));
    expect(error).toStrictEqual(
      new AttachError({ message: "no WebGL", cause: noWebGl })
    );
  });

  it("fails attach with the sheet's error when the sheet can't load", async () => {
    const missing = new SpriteSheetError({
      file: "sprites/survivors.json",
      message: "The sheet can't be loaded",
    });
    const coop = makeCoop(
      client(() => {
        throw new Error("never drawn");
      }),
      { load: Effect.fail(missing) } as unknown as SurvivorsEngineLoader
    );
    const error = await Effect.runPromise(Effect.flip(coop.attach(element)));
    expect(error).toBe(missing);
  });

  it("leaves the room when a frame crashes, so no seat is left to hold up the others", async () => {
    const log: string[] = [];
    const frames = manualFrames();
    const coop = makeCoop(
      Effect.runSync(
        Scope.provide(
          makeCoopClient({
            rooms: quietRooms(log),
            content: Effect.succeed({ heroes: [] } as unknown as GameContent),
            frames,
            createView: () => ({
              render: () => {
                throw new Error("lost context");
              },
              dispose: () => {},
            }),
          }),
          scope
        )
      ),
      loadedLoader
    );
    await Effect.runPromise(coop.host("spark"));
    await vi.waitFor(() => expect(log).toStrictEqual(["open host"]));
    const crashed = Effect.runPromise(Effect.flip(coop.attach(element)));
    await vi.waitFor(() => expect(frames.waiting()).toBe(true));
    frames.runFrameAt(16);
    const error = await crashed;
    expect({ error: error._tag, log }).toStrictEqual({
      error: "GameCrashed",
      log: ["open host", "release host"],
    });
  });
});
