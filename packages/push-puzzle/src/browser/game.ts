import { Audio } from "@gamekit/audio";
import type { AudioSystem } from "@gamekit/audio";
import { InputController } from "@gamekit/input";
import { combineViews, makeGameEngine } from "@gamekit/runtime/browser";
import type {
  GameDefinition,
  GameEngine,
  InputSource,
} from "@gamekit/runtime/browser";
import { Context, Effect, Layer } from "effect";

import type { PushPuzzleEvent } from "../events";
import { pushPuzzleSimulation } from "../simulation";
import type {
  Direction,
  Puzzle,
  PushPuzzleConfig,
  PushPuzzleInput,
} from "../world";
import { PushPuzzleSoundView } from "./sound";
import type { PushPuzzleSounds } from "./sound";
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

/** What the push-puzzle game plays its sounds through. */
export interface PushPuzzleAudio {
  /** The app's audio system. `silentAudio` from `@gamekit/audio` plays nothing. */
  readonly audio: AudioSystem;
  /** Which of the app's sounds each cue plays. */
  readonly sounds: PushPuzzleSounds;
}

/**
 * The push-puzzle genre as a @gamekit/runtime browser game: its simulation, input, and a view
 * that draws it and plays its sounds through `audio`.
 */
export const makePushPuzzleGame = ({
  audio,
  sounds,
}: PushPuzzleAudio): GameDefinition<
  PushPuzzleConfig,
  Puzzle,
  PushPuzzleInput,
  PushPuzzleEvent
> => ({
  ...pushPuzzleSimulation,
  createInput,
  createView: (container) =>
    combineViews<Puzzle>(
      new PushPuzzleView(container),
      new PushPuzzleSoundView(audio, sounds)
    ),
});

export class PushPuzzleEngine extends Context.Service<
  PushPuzzleEngine,
  GameEngine<PushPuzzleConfig, Puzzle, PushPuzzleEvent>
>()("@gamekit/push-puzzle/Engine") {}

/** Provides the engine, playing the cues' `sounds` through the `Audio` service. */
export const makePushPuzzleEngineLayer = (
  sounds: PushPuzzleSounds
): Layer.Layer<PushPuzzleEngine, never, Audio> =>
  Layer.effect(
    PushPuzzleEngine,
    Effect.gen(function* () {
      const audio = yield* Audio;
      return makeGameEngine(makePushPuzzleGame({ audio, sounds }));
    })
  );
