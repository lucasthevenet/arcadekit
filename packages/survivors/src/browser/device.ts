import type * as Game from "arcadekit/game/browser";
import { InputController } from "arcadekit/input";

import type { HeroInput } from "../input";

/**
 * One player's devices on `surface` (keys, touch, gamepad) as its hero's movement: what the
 * engine's input source and `SurvivorsCoop`'s both read. Returns one object, refilled each step.
 * `dispose` removes its listeners.
 */
export const heroDevice = (
  surface: HTMLElement
): Game.InputSource<HeroInput> => {
  const controller = InputController.make(surface, {
    axes: InputController.moveAxes,
  });
  const input = { moveX: 0, moveZ: 0 };
  return {
    read: () => {
      input.moveX = InputController.axis(controller, "moveX");
      input.moveZ = InputController.axis(controller, "moveY");
      return input;
    },
    endFrame: () => InputController.endFrame(controller),
    dispose: () => InputController.dispose(controller),
  };
};
