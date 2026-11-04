import { Audio } from "@gamekit/audio";
import type { SpriteSheetError } from "@gamekit/render-three";
import type { GameContent } from "@gamekit/survivors";
import { SurvivorsEngine } from "@gamekit/survivors/browser";
import type { SurvivorsEngineLoader } from "@gamekit/survivors/browser";
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
   * Draws the co-op run into `element` while the scope is open, with the engine's loaded art.
   * Fails with the sheet's error if it can't load.
   */
  readonly attach: (
    element: HTMLElement
  ) => Effect.Effect<void, SpriteSheetError, Scope.Scope>;
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
 * load, from `engines`), and fails with `SpriteSheetError` if it can't load.
 */
export const makeCoop = (
  client: CoopClient,
  engines: SurvivorsEngineLoader
): CoopApi => ({
  attach: (element) =>
    engines.load.pipe(
      Effect.flatMap(({ assets }) =>
        Effect.acquireRelease(
          Effect.sync(() => client.attach(element, assets)),
          (detach) => Effect.sync(detach)
        )
      ),
      Effect.asVoid
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
 * `SurvivorsEngine` loads.
 */
export const CoopLayer = Layer.effect(
  Coop,
  Effect.gen(function* () {
    const client = new CoopClient({
      signalling: { url: signallingUrl(), rtc: { iceServers: iceServers() } },
      sound: { audio: yield* Audio, sounds: survivorsSounds },
    });
    if (import.meta.env.DEV) {
      // For the end-to-end test and debugging: the run's step, error and recent state hashes.
      Object.assign(globalThis, {
        gamekitCoop: { debug: () => client.debug() },
      });
    }
    return makeCoop(client, yield* SurvivorsEngine);
  })
);
