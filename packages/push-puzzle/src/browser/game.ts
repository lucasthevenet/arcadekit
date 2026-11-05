import { Audio } from "@arcadekit/audio";
import type { AudioSystem } from "@arcadekit/audio";
import { InputController } from "@arcadekit/input";
import type { SpriteSheet, SpriteSheetError } from "@arcadekit/render-three";
import { combineViews, makeEngineLoader } from "@arcadekit/runtime/browser";
import type {
  EngineLoader,
  GameDefinition,
  InputSource,
} from "@arcadekit/runtime/browser";
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
  /** The app's audio system. `silentAudio` from `@arcadekit/audio` plays nothing. */
  readonly audio: AudioSystem;
  /** Which of the app's sounds each cue plays. */
  readonly sounds: PushPuzzleSounds;
}

/** What the push-puzzle game draws and plays: the app's sheet and sounds, which the app owns. */
export interface PushPuzzleAssets extends PushPuzzleAudio {
  /** The app's push-puzzle sheet, with every tag in `PUSH_PUZZLE_SPRITE_TAGS`. Never freed by the game. */
  readonly sheet: SpriteSheet;
}

/**
 * The push-puzzle genre as a @arcadekit/runtime browser game: its simulation, input, and a view
 * that draws it from `sheet` and plays its sounds through `audio`.
 */
export const makePushPuzzleGame = ({
  audio,
  sounds,
  sheet,
}: PushPuzzleAssets): GameDefinition<
  PushPuzzleConfig,
  Puzzle,
  PushPuzzleInput,
  PushPuzzleEvent
> => ({
  ...pushPuzzleSimulation,
  createInput,
  createView: (container) =>
    combineViews<Puzzle>(
      new PushPuzzleView(container, sheet),
      new PushPuzzleSoundView(audio, sounds)
    ),
});

/** How the app reaches the push-puzzle engine: through the load of its sheet (ADR-0015). */
export type PushPuzzleEngineLoader = EngineLoader<
  PushPuzzleConfig,
  Puzzle,
  PushPuzzleEvent,
  SpriteSheet,
  SpriteSheetError
>;

export class PushPuzzleEngine extends Context.Service<
  PushPuzzleEngine,
  PushPuzzleEngineLoader
>()("@arcadekit/push-puzzle/Engine") {}

/**
 * Provides `PushPuzzleEngine`: the engine, made once from the sheet `sheet` loads, playing the
 * cues' `sounds` through `Audio` (tests provide `SilentAudioLayer`). Building the layer loads
 * nothing. The app's LoadContent runs `load`, and every engine use goes through it
 * (`engineOf(PushPuzzleEngine)`), so there is no engine before its sheet. The layer's scope (the
 * app) frees the sheet.
 */
export const makePushPuzzleEngineLayer = (options: {
  /** The app's sheet load, such as `loadSpriteSheet(url)`. Run on the first `load`. */
  readonly sheet: Effect.Effect<SpriteSheet, SpriteSheetError>;
  readonly sounds: PushPuzzleSounds;
}): Layer.Layer<PushPuzzleEngine, never, Audio> =>
  Layer.effect(
    PushPuzzleEngine,
    Effect.gen(function* () {
      const audio = yield* Audio;
      return yield* makeEngineLoader({
        assets: options.sheet,
        game: (sheet) =>
          makePushPuzzleGame({ audio, sounds: options.sounds, sheet }),
        release: (sheet) => sheet.dispose(),
      });
    })
  );
