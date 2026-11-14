/**
 * Push-puzzle's controls: the player's devices on the viewport, read as the run's step input.
 *
 * Arrow keys, WASD, the gamepad's d-pad (standard mapping: buttons 12 to 15) or a swipe move;
 * Z, Backspace or the gamepad's B undo. A swipe is a press only, so it moves once and never
 * repeats. A press makes one turn, so each press reaches one step only, even on a slow frame that
 * runs several.
 *
 * Plain on purpose, at the bridge where host events meet a step: the input controller's listeners
 * write what a step reads while the browser dispatches each event, and the engine's `input` makes
 * the source with a plain `make`, and gives it back in an `acquireRelease` whose release calls
 * its `dispose`.
 */
import type * as Game from "arcadekit/game/browser";
import { InputController } from "arcadekit/input";

import type * as World from "../../world";

const DIRECTIONS = ["up", "down", "left", "right"] as const;

/** Each direction's and undo's keys, gamepad buttons and swipe: what `make` binds. */
export const buttons = {
  up: { keys: ["ArrowUp", "KeyW"], gamepadButtons: [12], swipe: "up" },
  down: { keys: ["ArrowDown", "KeyS"], gamepadButtons: [13], swipe: "down" },
  left: { keys: ["ArrowLeft", "KeyA"], gamepadButtons: [14], swipe: "left" },
  right: { keys: ["ArrowRight", "KeyD"], gamepadButtons: [15], swipe: "right" },
  undo: { keys: ["KeyZ", "Backspace"], gamepadButtons: [1] },
} as const;

/**
 * Makes the input source that reads a run's step input from the player's devices on `surface`:
 * what the engine's `input` returns.
 *
 * The direction that repeats while held is the one pressed last, even if an earlier one is still
 * down. `read` refills one object, so reading allocates nothing; `endStep` forgets the step's
 * presses, and `dispose` removes the listeners.
 */
export const make = (surface: HTMLElement): Game.InputSource<World.Input> => {
  const controller = InputController.make(surface, { buttons });
  // One object, refilled each step: reading input allocates nothing.
  const input: {
    -readonly [K in keyof World.Input]: World.Input[K];
  } = { held: null, pressed: null, undo: false };
  // The most recently pressed direction. It's the one that repeats while held,
  // even if an earlier direction is still down too.
  let latest: World.Direction | null = null;
  return {
    read: () => {
      input.pressed = null;
      for (const direction of DIRECTIONS) {
        if (
          input.pressed === null &&
          InputController.wasPressed(controller, direction)
        ) {
          input.pressed = direction;
          latest = direction;
        }
      }
      input.held =
        latest !== null && InputController.isDown(controller, latest)
          ? latest
          : null;
      input.undo = InputController.wasPressed(controller, "undo");
      return input;
    },
    // A press makes one turn, so each press must reach one step only, even on a slow
    // frame that runs several.
    endStep: () => InputController.consumePresses(controller),
    endFrame: () => InputController.endFrame(controller),
    dispose: () => InputController.dispose(controller),
  };
};
