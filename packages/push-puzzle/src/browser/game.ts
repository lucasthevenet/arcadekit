import { InputController } from "@gamekit/input";
import { makeGameEngine } from "@gamekit/runtime";
import type { GameDefinition, GameEngine, InputSource } from "@gamekit/runtime";
import { Context, Layer } from "effect";

import type { PushPuzzleEvent } from "../events";
import { createPuzzle, hudSample, step } from "../world";
import type {
  Direction,
  Puzzle,
  PushPuzzleConfig,
  PushPuzzleInput,
} from "../world";
import { PushPuzzleView } from "./view";

const DIRECTIONS = ["up", "down", "left", "right"] as const;

/**
 * Arrow keys, WASD, the gamepad d-pad (standard mapping: buttons 12-15) or a swipe for moves;
 * Z, Backspace or B for undo. A swipe is a press only, so it moves once and never repeats.
 */
const BUTTONS = {
  up: { keys: ["ArrowUp", "KeyW"], gamepadButtons: [12], swipe: "up" },
  down: { keys: ["ArrowDown", "KeyS"], gamepadButtons: [13], swipe: "down" },
  left: { keys: ["ArrowLeft", "KeyA"], gamepadButtons: [14], swipe: "left" },
  right: { keys: ["ArrowRight", "KeyD"], gamepadButtons: [15], swipe: "right" },
  undo: { keys: ["KeyZ", "Backspace"], gamepadButtons: [1] },
} as const;

const createInput = (surface: HTMLElement): InputSource<PushPuzzleInput> => {
  const controller = new InputController(surface, { buttons: BUTTONS });
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
    // A press makes one turn, so each press must reach one step only, even on a slow
    // frame that runs several.
    endStep: () => controller.consumePresses(),
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
  // The HUD changes only on a turn, so it's sent right after a turn, and never in between.
  sample: {
    version: (puzzle) => puzzle.turns,
    read: (puzzle) => ({ type: "hud", hud: hudSample(puzzle) }),
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
