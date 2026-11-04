import type { GameEngine } from "@gamekit/runtime/browser";
import type { GameContent } from "@gamekit/survivors";
import { Context, Effect, Layer } from "effect";

import { CoopClient } from "../coop/client";
import type { CoopEvent } from "../coop/client";
import { iceServers, signallingUrl } from "../coop/config";

/**
 * Co-op survivors (#25) as the app's Commands and Subscriptions use it: the lobby and the
 * lockstep run of `CoopClient`, behind Effects. `attach` and `listen` are what `engineEntry`
 * uses, as for the single-player engine; the rest are Commands'.
 */
export interface CoopApi extends Pick<
  GameEngine<unknown, unknown, CoopEvent>,
  "attach" | "listen"
> {
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

export const makeCoop = (client: CoopClient): CoopApi => ({
  attach: (element) =>
    Effect.acquireRelease(
      Effect.sync(() => client.attach(element)),
      (detach) => Effect.sync(detach)
    ).pipe(Effect.asVoid),
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

export const CoopLayer = Layer.sync(Coop, () => {
  const client = new CoopClient({
    signalling: { url: signallingUrl(), rtc: { iceServers: iceServers() } },
  });
  if (import.meta.env.DEV) {
    // For the end-to-end test and debugging: the run's step, error and recent state hashes.
    Object.assign(globalThis, { gamekitCoop: { debug: () => client.debug() } });
  }
  return makeCoop(client);
});
