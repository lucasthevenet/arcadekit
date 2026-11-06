import { SilentAudioLayer } from "@arcadekit/audio";
import { AttachError } from "@arcadekit/runtime/browser";
import { SurvivorsEngine } from "@arcadekit/survivors/browser";
import type { SurvivorsEngineLoader } from "@arcadekit/survivors/browser";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoopClient } from "../coop/client";
import { CoopLayer, makeCoop } from "./coop";

// CoopLayer and makeCoop with nothing real behind them: no room is opened, nothing draws.

/** A loader whose load never finishes: building CoopLayer loads nothing. */
const idleLoader = { load: Effect.never } as unknown as SurvivorsEngineLoader;

/** A loader that has loaded, with art nothing reads. */
const loadedLoader = {
  load: Effect.succeed({ assets: {}, engine: {} }),
} as unknown as SurvivorsEngineLoader;

describe("the co-op layer", () => {
  beforeEach(() => {
    // The signalling URL is the page's own origin.
    vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("leaves and removes its debug global when the app's scope closes", async () => {
    const leave = vi.spyOn(CoopClient.prototype, "leave");
    const layer = CoopLayer.pipe(
      Layer.provide(SilentAudioLayer),
      Layer.provide(Layer.succeed(SurvivorsEngine, idleLoader))
    );
    const scope = Effect.runSync(Scope.make());
    await Effect.runPromise(Layer.buildWithScope(layer, scope));
    const whileOpen = "arcadekitCoop" in globalThis;
    const leftWhileOpen = leave.mock.calls.length;
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect({
      whileOpen,
      leftWhileOpen,
      left: leave.mock.calls.length,
      afterClose: "arcadekitCoop" in globalThis,
    }).toStrictEqual({
      whileOpen: true,
      leftWhileOpen: 0,
      left: 1,
      afterClose: false,
    });
  });
});

describe(makeCoop, () => {
  it("fails attach with an AttachError when the client can't draw, as with no WebGL", async () => {
    const noWebGl = new Error("no WebGL");
    const client = {
      attach: () => {
        throw noWebGl;
      },
    } as unknown as CoopClient;
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.flip(makeCoop(client, loadedLoader).attach({} as HTMLElement))
      )
    );
    expect(error).toBeInstanceOf(AttachError);
    expect(error).toMatchObject({ message: "no WebGL", cause: noWebGl });
  });
});
