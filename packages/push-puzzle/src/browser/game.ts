import { AudioSystem } from "arcadekit/audio";
import { Asset } from "arcadekit/content";
import * as Game from "arcadekit/game/browser";
import { InputController } from "arcadekit/input";
import { SpriteSheet } from "arcadekit/render-three";

import { PushPuzzle } from "../simulation";
import type { Direction, PushPuzzleInput } from "../world";
import { PushPuzzleCueTable, PushPuzzleSoundView } from "./sound";
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

/** Reads push-puzzle's step input from the keyboard, a gamepad or a swipe on `surface`. */
export const pushPuzzleInput = (
  surface: HTMLElement
): Game.InputSource<PushPuzzleInput> => {
  const controller = InputController.make(surface, { buttons: BUTTONS });
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

/**
 * The app's push-puzzle sheet, with the first tag of each name in `PUSH_PUZZLE_TAGS` (ADR-0015). The app
 * says where it comes from, `PushPuzzleSheet.layer(SpriteSheet.fromUrl(url))`, and loads it on its
 * loading screen; the engine draws from it and never frees it. The app's end does.
 */
export class PushPuzzleSheet extends Asset<
  SpriteSheet.SpriteSheet,
  SpriteSheet.SpriteSheetError
>()("PushPuzzleSheet", { release: SpriteSheet.dispose }) {}

/**
 * The push-puzzle genre in the browser: its rules, a view that draws them from the app's sheet
 * and plays their cues, with the sounds the app gives its cue table, through the app's audio
 * system (`AudioSystem.AudioSystem`; tests provide `AudioSystem.layerSilent`), and its input.
 * `PushPuzzleEngine.layer` provides the engine; building it loads nothing, and each attach loads
 * the sheet, or takes the one already loaded.
 */
export class PushPuzzleEngine extends Game.Engine("PushPuzzleEngine", {
  simulation: PushPuzzle,
  uses: {
    audio: AudioSystem.AudioSystem,
    sounds: PushPuzzleCueTable,
    sheet: PushPuzzleSheet.load,
  },
  view: (container, { audio, sounds, sheet }) =>
    Game.combineViews(
      new PushPuzzleView(container, sheet),
      new PushPuzzleSoundView(audio, sounds)
    ),
  input: pushPuzzleInput,
}) {}
