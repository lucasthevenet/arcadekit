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
import { SurvivorsSprites } from "./art";
import type { SurvivorsArt } from "./art";
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

/** What a survivors game is made with: the art it draws, and the sound it plays, if any. */
export interface SurvivorsGameOptions {
  readonly art: SurvivorsArt;
  /** Without it, the game is silent. */
  readonly sound?: SurvivorsGameSound;
}

/**
 * The survivors genre as a @gamekit/runtime browser game, for a single player: its simulation,
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

export class SurvivorsEngine extends Context.Service<
  SurvivorsEngine,
  GameEngine<SurvivorsConfig, World, SurvivorsEvent>
>()("@gamekit/survivors/Engine") {}

/**
 * Provides `SurvivorsEngine`, drawing with the `SurvivorsSprites` art and playing its sounds from
 * `sounds` through the `Audio` service. Tests provide `SilentAudioLayer`.
 *
 * The engine makes its game when it is first attached, listened to or started, once the art has
 * loaded; it dies if the art can't load. So the app loads the art first (with its content) and
 * shows a failed load itself, attaching the engine only after a success. Before that there is no
 * run, and `modify`, `setPaused` and `stop` do nothing.
 */
export const makeSurvivorsEngineLayer = (
  sounds: SurvivorsSounds
): Layer.Layer<SurvivorsEngine, never, Audio | SurvivorsSprites> =>
  Layer.effect(
    SurvivorsEngine,
    Effect.gen(function* () {
      const audio = yield* Audio;
      const sprites = yield* SurvivorsSprites;
      type Engine = GameEngine<SurvivorsConfig, World, SurvivorsEvent>;
      let engine: Engine | undefined;
      const made: Effect.Effect<Engine> = Effect.suspend(() =>
        engine === undefined
          ? sprites.load.pipe(
              Effect.map((art) => {
                engine ??= makeGameEngine(
                  makeSurvivorsGame({ art, sound: { audio, sounds } })
                );
                return engine;
              })
            )
          : Effect.succeed(engine)
      ).pipe(Effect.orDie);
      const ifMade = (use: (made: Engine) => Effect.Effect<void>) =>
        Effect.suspend(() =>
          engine === undefined ? Effect.void : use(engine)
        );
      return {
        attach: (element) =>
          made.pipe(Effect.flatMap((game) => game.attach(element))),
        listen: (onEvent) =>
          made.pipe(Effect.flatMap((game) => game.listen(onEvent))),
        start: (config, seed) =>
          made.pipe(Effect.flatMap((game) => game.start(config, seed))),
        modify: (change) => ifMade((game) => game.modify(change)),
        setPaused: (paused) => ifMade((game) => game.setPaused(paused)),
        stop: ifMade((game) => game.stop),
      };
    })
  );
