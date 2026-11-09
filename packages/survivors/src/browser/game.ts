import { Audio } from "arcadekit/audio";
import type { AudioSystem } from "arcadekit/audio";
import { InputController, MOVE_AXES } from "arcadekit/input";
import type { SpriteSheet, SpriteSheetError } from "arcadekit/render-three";
import { combineViews, makeEngineLoader } from "arcadekit/runtime/browser";
import type { EngineLoader, GameDefinition } from "arcadekit/runtime/browser";
import { Context, Effect, Layer } from "effect";

import type { SurvivorsEvent } from "../events";
import { soloInput } from "../input";
import type { SurvivorsInput } from "../input";
import { survivorsSimulation } from "../simulation";
import type { SurvivorsConfig, World } from "../world";
import type { SurvivorsArt } from "./art";
import { SurvivorsSoundView } from "./sound";
import type { SurvivorsSounds } from "./sound";
import { SurvivorsView } from "./view";

type SurvivorsGame = GameDefinition<
  SurvivorsConfig,
  World,
  SurvivorsInput,
  SurvivorsEvent
>;

/** What a survivors game plays its sounds through: the app's audio system and its cue table. */
export interface SurvivorsGameSound {
  readonly audio: AudioSystem;
  readonly sounds: SurvivorsSounds;
}

/** What a survivors game is made with: the art it draws, and the sound it plays, if any. */
interface SurvivorsGameOptions {
  readonly art: SurvivorsArt;
  /** Without it, the game is silent. */
  readonly sound?: SurvivorsGameSound;
}

/**
 * The survivors genre as a arcadekit/runtime browser game, for a single player: its simulation,
 * input and view. The device drives the first hero. The view draws from `art`; with `sound`, a
 * sound view plays the run beside it.
 */
export const makeSurvivorsGame = ({
  art,
  sound,
}: SurvivorsGameOptions): SurvivorsGame => ({
  ...survivorsSimulation,
  createInput: (surface) => {
    const controller = new InputController(surface, { axes: MOVE_AXES });
    const source = soloInput({
      read: () => ({
        moveX: controller.axis("moveX"),
        moveZ: controller.axis("moveY"),
      }),
      endFrame: () => controller.endFrame(),
    });
    return { ...source, dispose: () => controller.dispose() };
  },
  createView: (container) =>
    sound === undefined
      ? new SurvivorsView(container, art)
      : combineViews<World>(
          new SurvivorsView(container, art),
          new SurvivorsSoundView(sound)
        ),
});

/** How the app reaches the survivors engine: through the load of its sheet (ADR-0015). */
export type SurvivorsEngineLoader = EngineLoader<
  SurvivorsConfig,
  World,
  SurvivorsEvent,
  SurvivorsArt,
  SpriteSheetError
>;

export class SurvivorsEngine extends Context.Service<
  SurvivorsEngine,
  SurvivorsEngineLoader
>()("@arcadekit/survivors/Engine") {}

/**
 * Provides `SurvivorsEngine`: the engine, made once from the sheet `sheet` loads, playing its
 * sounds from `sounds` through `Audio` (tests provide `SilentAudioLayer`). Building the layer
 * loads nothing. The app's LoadContent runs `load`, and every engine use goes through it
 * (`engineOf(SurvivorsEngine)`), so there is no engine before its sheet. The layer's scope (the
 * app) frees the sheet.
 */
export const makeSurvivorsEngineLayer = (options: {
  /** The app's sheet load, such as `loadSpriteSheet(url)`. Run on the first `load`. */
  readonly sheet: Effect.Effect<SpriteSheet, SpriteSheetError>;
  readonly sounds: SurvivorsSounds;
}): Layer.Layer<SurvivorsEngine, never, Audio> =>
  Layer.effect(
    SurvivorsEngine,
    Effect.gen(function* () {
      const audio = yield* Audio;
      const loadArt: Effect.Effect<SurvivorsArt, SpriteSheetError> =
        options.sheet.pipe(Effect.map((sheet) => ({ sheet })));
      return yield* makeEngineLoader({
        assets: loadArt,
        game: (art) =>
          makeSurvivorsGame({ art, sound: { audio, sounds: options.sounds } }),
        release: (art) => art.sheet.dispose(),
      });
    })
  );
