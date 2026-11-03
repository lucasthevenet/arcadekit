import { InputController, MOVE_AXES } from "@gamekit/input";
import { makeGameEngine } from "@gamekit/runtime";
import type { GameDefinition, GameEngine } from "@gamekit/runtime";
import { Context, Layer } from "effect";

import { createWorld, hudSample, step } from "../world";
import type {
  SurvivorsConfig,
  SurvivorsEvent,
  SurvivorsInput,
  World,
} from "../world";
import { SurvivorsView } from "./view";

/** The survivors genre as a @gamekit/runtime game. */
export const survivorsGame: GameDefinition<
  SurvivorsConfig,
  World,
  SurvivorsInput,
  SurvivorsEvent
> = {
  stepSeconds: 1 / 60,
  create: createWorld,
  step,
  drainEvents: (world) => world.events.drain(),
  sample: {
    everyMs: 100,
    read: (world) => ({ type: "hud", hud: hudSample(world) }),
  },
  createInput: (surface) => {
    const controller = new InputController(surface, { axes: MOVE_AXES });
    return {
      read: () => ({
        moveX: controller.axis("moveX"),
        moveZ: controller.axis("moveY"),
      }),
      endFrame: () => controller.endFrame(),
      dispose: () => controller.dispose(),
    };
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
