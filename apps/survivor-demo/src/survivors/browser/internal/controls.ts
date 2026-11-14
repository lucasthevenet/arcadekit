/**
 * Survivors' controls: a player's devices on the viewport, read as its hero's movement.
 *
 * The arrow keys, WASD, a gamepad's left stick or a drag on the viewport move the hero
 * (`InputController.moveAxes`), each axis in [-1, 1]; the screen's up is the arena's -z. The
 * Coop reads one player's source, for the local player's seat; the engine's is the same source,
 * seated at slot 0 of a run of one.
 *
 * Plain on purpose, at the bridge where host events meet a step: the input controller's listeners
 * write what a step reads while the browser dispatches each event, and the engine's or the Co-op
 * client's `input` makes the source with a plain `make`, and gives it back in an `acquireRelease`
 * whose release calls its `dispose`.
 */
import * as Game from "arcadekit/game/browser";
import { InputController } from "arcadekit/input";

import type * as Hero from "../../hero";
import type * as World from "../../world";

/**
 * Makes the input source that reads one player's `Hero.Input` from its devices on `surface`:
 * what `SurvivorsCoop`'s `input` returns, for the local player's seat.
 *
 * `read` refills one object, so reading allocates nothing; `endFrame` ends the controller's frame,
 * and `dispose` removes its listeners.
 */
export const make = (surface: HTMLElement): Game.InputSource<Hero.Input> => {
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

/**
 * Makes the input source of a run of one player from its devices on `surface`: its `Hero.Input`
 * at slot 0, and nobody leaving. What the engine's `input` returns.
 *
 * `read` refills one step input, so reading allocates nothing, and `dispose` removes the
 * controller's listeners.
 */
export const makeSolo = (
  surface: HTMLElement
): Game.InputSource<World.Input> => {
  const device = make(surface);
  // `Game.soloInput` seats a step input, which has no `dispose`: the device's is handed on.
  return { ...Game.soloInput(device), dispose: device.dispose };
};
