import type * as Game from "arcadekit/game/browser";
import { InputController, MOVE_AXES } from "arcadekit/input";

import type { HeroInput } from "../input";

/**
 * One player's devices on `surface` (keys, touch, gamepad) as its hero's movement: what the
 * engine's input source and `SurvivorsCoop`'s both read. Returns one object, refilled each step.
 * `dispose` removes its listeners.
 */
export const heroDevice = (
  surface: HTMLElement
): Game.InputSource<HeroInput> => {
  const controller = new InputController(surface, { axes: MOVE_AXES });
  const input = { moveX: 0, moveZ: 0 };
  return {
    read: () => {
      input.moveX = controller.axis("moveX");
      input.moveZ = controller.axis("moveY");
      return input;
    },
    endFrame: () => controller.endFrame(),
    dispose: () => controller.dispose(),
  };
};
