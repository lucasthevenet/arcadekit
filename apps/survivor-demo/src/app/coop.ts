import { Audio } from "@arcadekit/audio";
import type { AttachableEngine } from "@arcadekit/foldkit";
import type { SpriteSheetError } from "@arcadekit/render-three";
import type { AttachError, GameCrashed } from "@arcadekit/runtime/browser";
import { SurvivorsContent } from "@arcadekit/survivors";
import { SurvivorsEngine } from "@arcadekit/survivors/browser";
import type { SurvivorsEngineLoader } from "@arcadekit/survivors/browser";
import { Context, Effect, Layer } from "effect";

import { makeCoopClient } from "../coop/client";
import type { CoopClient, CoopEvent, CoopRooms } from "../coop/client";
import { browserRooms } from "../coop/config";
import { survivorsSounds } from "./sound";

/**
 * Co-op survivors (#25) as the app's Commands and Subscriptions use it: the co-op client's
 * lobby and lockstep run. `attach` and `listen` are what `engineEntry` uses, as for the
 * single-player engine; the rest are Commands'.
 *
 * `attach` draws the co-op run with the engine's loaded art for as long as it runs, and
 * detaches when interrupted. It fails with the sheet's error if the sheet can't load,
 * `AttachError` if the client can't draw (no WebGL), and `GameCrashed` if a frame throws,
 * after leaving the lobby or run.
 */
export interface CoopApi extends AttachableEngine<
  CoopEvent,
  SpriteSheetError | AttachError | GameCrashed
> {
  /** Hosts a room, after leaving any before it. The lobby and the run report through `listen`. */
  readonly host: (heroId: string) => Effect.Effect<void>;
  readonly join: (code: string, heroId: string) => Effect.Effect<void>;
  readonly chooseHero: (heroId: string) => Effect.Effect<void>;
  readonly start: Effect.Effect<void>;
  readonly pickUpgrade: (offer: number, index: number) => Effect.Effect<void>;
  readonly setPaused: (paused: boolean) => Effect.Effect<void>;
  /** Leaves the lobby or the run, once its room, links, session and worker have closed. */
  readonly leave: Effect.Effect<void>;
}

export class Coop extends Context.Service<Coop, CoopApi>()(
  "survivor-demo/Coop"
) {}

/** `client`'s API, drawing with the art `engines` loads: one sheet, one load. */
export const makeCoop = (
  client: CoopClient,
  engines: SurvivorsEngineLoader
): CoopApi => ({
  host: client.host,
  join: client.join,
  chooseHero: client.chooseHero,
  start: client.start,
  pickUpgrade: client.pickUpgrade,
  setPaused: client.setPaused,
  leave: client.leave,
  listen: client.listen,
  attach: (element) =>
    engines.load.pipe(
      Effect.flatMap(({ assets }) => client.attach(element, assets)),
      // The app then shows co-op as stopped, so this player leaves: a seat left running would
      // freeze the others' run at its hero's next upgrade offer, or while it holds the pause.
      Effect.tapError(() => client.leave)
    ),
});

/**
 * The co-op client over `rooms()`, playing its sounds through the `Audio` service, loading the
 * run's content from `SurvivorsContent` and drawing with the art `SurvivorsEngine` loads. The
 * layer's scope (the app) owns the client: when it closes, the client leaves, and its socket,
 * peer links, session and tick worker close.
 */
export const makeCoopLayer = (
  rooms: () => CoopRooms
): Layer.Layer<Coop, never, Audio | SurvivorsEngine | SurvivorsContent> =>
  Layer.effect(
    Coop,
    Effect.gen(function* () {
      const audio = yield* Audio;
      const contentLoader = yield* SurvivorsContent;
      const client = yield* makeCoopClient({
        rooms: rooms(),
        content: contentLoader.load,
        sound: { audio, sounds: survivorsSounds },
      });
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

/** The app's co-op: rooms on the signalling worker that serves the page. */
export const CoopLayer: Layer.Layer<
  Coop,
  never,
  Audio | SurvivorsEngine | SurvivorsContent
> = makeCoopLayer(browserRooms);
