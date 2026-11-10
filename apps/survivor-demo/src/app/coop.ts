import { SurvivorsContent } from "@arcadekit/survivors";
import type { SurvivorsCoop } from "@arcadekit/survivors";
import {
  SurvivorsEngine,
  makeSurvivorsCoopGame,
} from "@arcadekit/survivors/browser";
import { Audio } from "arcadekit/audio";
import { makeCoopClient } from "arcadekit/net/browser";
import type {
  CoopClient,
  CoopClientOptions,
  CoopDebug,
  CoopRooms,
} from "arcadekit/net/browser";
import type { SpriteSheetError } from "arcadekit/render-three";
import { Context, Effect, Layer } from "effect";

import { browserRooms } from "../coop/config";
import { survivorsSounds } from "./sound";

/**
 * Co-op survivors (#25) as the app's Commands and Subscriptions use it: the kit's Co-op client
 * playing the survivors Co-op game. `attach` and `listen` are what `engineEntry` uses, as for
 * the single-player engine; the rest are Commands'. `attach` fails with the sheet's error if
 * the sheet can't load.
 */
export type CoopApi = CoopClient<SurvivorsCoop, SpriteSheetError>;

export class Coop extends Context.Service<Coop, CoopApi>()(
  "survivor-demo/Coop"
) {}

/** What the end-to-end test and a debugging player read of a run: plain data, no World. */
export interface CoopDebugSample {
  readonly stepIndex: number;
  readonly error: string | null;
  readonly hashes: Readonly<Record<number, number>>;
  readonly slot: number;
  /** The team's level and the run's time in seconds, or null with no run. */
  readonly level: number | null;
  readonly time: number | null;
}

/** The client's debug read without the World, which is too big to copy out of the page. */
export const debugSample = ({
  state,
  ...rest
}: CoopDebug<SurvivorsCoop["State"]>): CoopDebugSample => ({
  ...rest,
  level: state?.level ?? null,
  time: state?.time ?? null,
});

/**
 * The Co-op client over `rooms()`, playing its sounds through the `Audio` service, loading the
 * run's content from `SurvivorsContent` and drawing with the art `SurvivorsEngine` loads: one
 * sheet, one load. The layer's scope (the app) owns the client: when it closes, the client
 * leaves, and its socket, peer links, session and tick worker close. Tests pass a ticker and a
 * frame clock in `options`.
 */
export const makeCoopLayer = (
  rooms: () => CoopRooms,
  options: Omit<CoopClientOptions, "rooms"> = {}
): Layer.Layer<Coop, never, Audio | SurvivorsEngine | SurvivorsContent> =>
  Layer.effect(
    Coop,
    Effect.gen(function* () {
      const audio = yield* Audio;
      const contentLoader = yield* SurvivorsContent;
      const engines = yield* SurvivorsEngine;
      const client = yield* makeCoopClient(
        makeSurvivorsCoopGame({
          content: contentLoader.load,
          art: engines.load.pipe(Effect.map(({ assets }) => assets)),
          sound: { audio, sounds: survivorsSounds },
        }),
        { ...options, rooms: rooms() }
      );
      if (import.meta.env.DEV) {
        // For the end-to-end test and debugging: the run's step, error and recent state hashes.
        Object.assign(globalThis, {
          arcadekitCoop: { debug: () => debugSample(client.debug()) },
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            Reflect.deleteProperty(globalThis, "arcadekitCoop");
          })
        );
      }
      return client;
    })
  );

/** The app's co-op: rooms on the signalling worker that serves the page. */
export const CoopLayer: Layer.Layer<
  Coop,
  never,
  Audio | SurvivorsEngine | SurvivorsContent
> = makeCoopLayer(browserRooms);
