import { Audio } from "arcadekit/audio";
import type { AudioSystem } from "arcadekit/audio";
import type { SpriteSheet, SpriteSheetError } from "arcadekit/render-three";
import { soloInput } from "arcadekit/runtime";
import { combineViews, makeEngineLoader } from "arcadekit/runtime/browser";
import type {
  EngineLoader,
  GameDefinition,
  GameView,
} from "arcadekit/runtime/browser";
import { Context, Effect, Layer } from "effect";

import type { SurvivorsEvent } from "../events";
import type { SurvivorsInput } from "../input";
import { survivorsSimulation } from "../simulation";
import type { SurvivorsConfig, World } from "../world";
import type { SurvivorsArt } from "./art";
import { heroDevice } from "./device";
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
 * A survivors run's views: the sprite view and, with `sound`, a sound view beside it. Both read
 * `localHero`, the local player's slot, on every frame; without it they follow slot 0.
 */
export const survivorsViews = (
  container: HTMLElement,
  art: SurvivorsArt,
  sound?: SurvivorsGameSound,
  localHero?: () => number
): GameView<World> => {
  const options = localHero === undefined ? {} : { localHero };
  const view = new SurvivorsView(container, art, options);
  return sound === undefined
    ? view
    : combineViews<World>(
        view,
        new SurvivorsSoundView({ ...sound, ...options })
      );
};

/**
 * The survivors genre as an arcadekit/runtime browser game, for a single player: its simulation,
 * input and view. The device drives the first hero. The view draws from `art`; with `sound`, a
 * sound view plays the run beside it.
 */
export const makeSurvivorsGame = ({
  art,
  sound,
}: SurvivorsGameOptions): SurvivorsGame => ({
  ...survivorsSimulation,
  createInput: (surface) => {
    const device = heroDevice(surface);
    return { ...soloInput(device), dispose: device.dispose };
  },
  createView: (container) => survivorsViews(container, art, sound),
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
