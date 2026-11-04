import { Audio } from "@gamekit/audio";
import type { AudioSystem } from "@gamekit/audio";
import { InputController, MOVE_AXES } from "@gamekit/input";
import { combineViews, makeGameEngine } from "@gamekit/runtime/browser";
import type { GameDefinition, GameEngine } from "@gamekit/runtime/browser";
import { Context, Effect, Layer } from "effect";

import type { SurvivorsEvent } from "../events";
import { soloInput } from "../input";
import type { SurvivorsInput } from "../input";
import { survivorsSimulation } from "../simulation";
import type { SurvivorsConfig, World } from "../world";
import { SurvivorsSoundView } from "./sound";
import type { SurvivorsSounds } from "./sound";
import { SurvivorsView } from "./view";

export type SurvivorsGame = GameDefinition<
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

/**
 * The survivors genre as a @gamekit/runtime browser game, for a single player: its simulation,
 * input and view. The device drives the first hero. With `sound`, a sound view plays the run
 * beside the drawing view; without it, the game is silent.
 */
export const makeSurvivorsGame = (
  sound?: SurvivorsGameSound
): SurvivorsGame => ({
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
      ? new SurvivorsView(container)
      : combineViews<World>(
          new SurvivorsView(container),
          new SurvivorsSoundView(sound)
        ),
});

export class SurvivorsEngine extends Context.Service<
  SurvivorsEngine,
  GameEngine<SurvivorsConfig, World, SurvivorsEvent>
>()("@gamekit/survivors/Engine") {}

/**
 * Provides `SurvivorsEngine`, playing its sounds from `sounds` through the `Audio` service.
 * Tests provide `SilentAudioLayer`.
 */
export const makeSurvivorsEngineLayer = (
  sounds: SurvivorsSounds
): Layer.Layer<SurvivorsEngine, never, Audio> =>
  Layer.effect(
    SurvivorsEngine,
    Effect.gen(function* () {
      const audio = yield* Audio;
      return makeGameEngine(makeSurvivorsGame({ audio, sounds }));
    })
  );
