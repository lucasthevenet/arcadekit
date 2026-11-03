import { InputController } from "@gamekit/input";
import { makeGameEngine } from "@gamekit/runtime";
import type { GameDefinition, GameEngine, InputSource } from "@gamekit/runtime";
import { Context, Layer } from "effect";

import { createPuzzle, hudSnapshot, step } from "../world";
import type {
  Direction,
  Puzzle,
  PushPuzzleConfig,
  PushPuzzleEvent,
  PushPuzzleInput,
} from "../world";
import { PushPuzzleView } from "./view";

const DIRECTIONS = ["up", "down", "left", "right"] as const;

/** Arrow keys, WASD and the gamepad d-pad (standard mapping: buttons 12-15) for moves; Z, Backspace or B for undo. */
const BUTTONS = {
  up: { keys: ["ArrowUp", "KeyW"], gamepadButtons: [12] },
  down: { keys: ["ArrowDown", "KeyS"], gamepadButtons: [13] },
  left: { keys: ["ArrowLeft", "KeyA"], gamepadButtons: [14] },
  right: { keys: ["ArrowRight", "KeyD"], gamepadButtons: [15] },
  undo: { keys: ["KeyZ", "Backspace"], gamepadButtons: [1] },
} as const;

const createInput = (surface: HTMLElement): InputSource<PushPuzzleInput> => {
  const controller = new InputController<never, keyof typeof BUTTONS>(surface, {
    axes: {},
    buttons: BUTTONS,
  });
  // One object, refilled each step: reading input allocates nothing.
  const input: {
    -readonly [K in keyof PushPuzzleInput]: PushPuzzleInput[K];
  } = { held: null, pressed: null, undo: false };
  // The most recently pressed direction. It's the one that repeats while held,
  // even if an earlier direction is still down too.
  let latest: Direction | null = null;
  return {
    read: () => {
      input.pressed = null;
      for (const direction of DIRECTIONS) {
        if (input.pressed === null && controller.wasPressed(direction)) {
          input.pressed = direction;
          latest = direction;
        }
      }
      input.held = latest !== null && controller.isDown(latest) ? latest : null;
      input.undo = controller.wasPressed("undo");
      return input;
    },
    endFrame: () => controller.endFrame(),
    dispose: () => controller.dispose(),
  };
};

/** The push-puzzle genre as a @gamekit/runtime game. */
export const pushPuzzleGame: GameDefinition<
  PushPuzzleConfig,
  Puzzle,
  PushPuzzleInput,
  PushPuzzleEvent
> = {
  stepSeconds: 1 / 60,
  create: createPuzzle,
  step,
  drainEvents: (puzzle) => puzzle.events.drain(),
  // The HUD changes only on a turn, but `sample` runs on wall-clock time, so the
  // UI hears about a move up to 100 ms late (see docs/push-puzzle-findings.md).
  sample: {
    everyMs: 100,
    read: (puzzle) => ({ type: "hud", hud: hudSnapshot(puzzle) }),
  },
  createInput,
  createView: (container) => new PushPuzzleView(container),
};

export class PushPuzzleEngine extends Context.Service<
  PushPuzzleEngine,
  GameEngine<PushPuzzleConfig, Puzzle, PushPuzzleEvent>
>()("@gamekit/push-puzzle/Engine") {}

export const PushPuzzleEngineLayer = Layer.sync(PushPuzzleEngine, () =>
  makeGameEngine(pushPuzzleGame)
);
