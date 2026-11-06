import { Audio } from "@arcadekit/audio";
import type { SpriteSheetError } from "@arcadekit/render-three";
import { attachError } from "@arcadekit/runtime/browser";
import type { AttachError } from "@arcadekit/runtime/browser";
import type { GameContent } from "@arcadekit/survivors";
import { SurvivorsEngine } from "@arcadekit/survivors/browser";
import type { SurvivorsEngineLoader } from "@arcadekit/survivors/browser";
import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";

import { CoopClient } from "../coop/client";
import type { CoopEvent } from "../coop/client";
import { iceServers, signallingUrl } from "../coop/config";
import { survivorsSounds } from "./sound";

/**
 * Co-op survivors (#25) as the app's Commands and Subscriptions use it: the lobby and the
 * lockstep run of `CoopClient`, behind Effects. `attach` and `listen` are what `engineEntry`
 * uses, as for the single-player engine; the rest are Commands'.
 */
export interface CoopApi {
  /**
   * Draws the co-op run into `element` with the engine's loaded art for as long as it runs,
   * and detaches when interrupted. Fails with the sheet's error if it can't load, and with
   * `AttachError` if the client can't draw (no WebGL).
   */
  readonly attach: (
    element: HTMLElement
  ) => Effect.Effect<never, SpriteSheetError | AttachError>;
  /** Calls `onEvent` for every co-op event while the scope is open. */
  readonly listen: (
    onEvent: (event: CoopEvent) => void
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly host: (content: GameContent, heroId: string) => Effect.Effect<void>;
  readonly join: (
    content: GameContent,
    code: string,
    heroId: string
  ) => Effect.Effect<void>;
  readonly chooseHero: (heroId: string) => Effect.Effect<void>;
  readonly start: Effect.Effect<void>;
  readonly pickUpgrade: (offer: number, index: number) => Effect.Effect<void>;
  readonly setPaused: (paused: boolean) => Effect.Effect<void>;
  readonly leave: Effect.Effect<void>;
}

export class Coop extends Context.Service<Coop, CoopApi>()(
  "survivor-demo/Coop"
) {}

/**
 * The co-op API over `client`. `attach` draws with the engine's loaded art (one sheet, one
 * load, from `engines`), and fails with `SpriteSheetError` if it can't load, or `AttachError`
 * if the client's view can't be made.
 */
export const makeCoop = (
  client: CoopClient,
  engines: SurvivorsEngineLoader
): CoopApi => ({
  attach: (element) =>
    engines.load.pipe(
      Effect.flatMap(({ assets }) =>
        Effect.acquireRelease(
          Effect.try({
            try: () => client.attach(element, assets),
            catch: attachError,
          }),
          (detach) => Effect.sync(detach)
        )
      ),
      // The client draws on its own animation frames until it is detached.
      Effect.andThen(Effect.never),
      Effect.scoped
    ),
  listen: (onEvent) =>
    Effect.acquireRelease(
      Effect.sync(() => client.subscribe(onEvent)),
      (unsubscribe) => Effect.sync(unsubscribe)
    ).pipe(Effect.asVoid),
  host: (content, heroId) => Effect.sync(() => client.host(content, heroId)),
  join: (content, code, heroId) =>
    Effect.sync(() => client.join(content, code, heroId)),
  chooseHero: (heroId) => Effect.sync(() => client.chooseHero(heroId)),
  start: Effect.sync(() => client.start()),
  pickUpgrade: (offer, index) =>
    Effect.sync(() => client.pickUpgrade(offer, index)),
  setPaused: (paused) => Effect.sync(() => client.setPaused(paused)),
  leave: Effect.sync(() => client.leave()),
});

/**
 * The co-op client, playing its sounds through the `Audio` service and drawing with the art
 * `SurvivorsEngine` loads. When the layer's scope (the app) closes, the client leaves: its
 * signalling socket, peer links and tick worker close.
 */
export const CoopLayer = Layer.effect(
  Coop,
  Effect.gen(function* () {
    const audio = yield* Audio;
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new CoopClient({
            signalling: {
              url: signallingUrl(),
              rtc: { iceServers: iceServers() },
            },
            sound: { audio, sounds: survivorsSounds },
          })
      ),
      // Safe when idle: with no room or run, leaving closes nothing.
      (coop) => Effect.sync(() => coop.leave())
    );
    if (import.meta.env.DEV) {
      // For the end-to-end test and debugging: the run's step, error and recent state hashes.
      Object.assign(globalThis, {
        arcadekitCoop: { debug: () => client.debug() },
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Reflect.deleteProperty(globalThis, "arcadekitCoop");
        })
      );
    }
    return makeCoop(client, yield* SurvivorsEngine);
  })
);
