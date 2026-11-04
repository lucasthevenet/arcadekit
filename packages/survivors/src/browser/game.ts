import { InputController, MOVE_AXES } from "@gamekit/input";
import { makeGameEngine } from "@gamekit/runtime/browser";
import type { GameDefinition, GameEngine } from "@gamekit/runtime/browser";
import { Context, Layer } from "effect";

import type { SurvivorsEvent } from "../events";
import { soloInput } from "../input";
import type { SurvivorsInput } from "../input";
import { survivorsSimulation } from "../simulation";
import type { SurvivorsConfig, World } from "../world";
import { SurvivorsView } from "./view";

/**
 * The survivors genre as a @gamekit/runtime browser game, for a single player: its simulation,
 * input and view. The device drives the first hero.
 */
export const survivorsGame: GameDefinition<
  SurvivorsConfig,
  World,
  SurvivorsInput,
  SurvivorsEvent
> = {
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
  createView: (container) => new SurvivorsView(container),
};

export class SurvivorsEngine extends Context.Service<
  SurvivorsEngine,
  GameEngine<SurvivorsConfig, World, SurvivorsEvent>
>()("@gamekit/survivors/Engine") {}

export const SurvivorsEngineLayer = Layer.sync(SurvivorsEngine, () =>
  makeGameEngine(survivorsGame)
);
