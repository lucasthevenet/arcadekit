/**
 * Push-puzzle's engine, declared: the genre as the browser runs it for one player.
 *
 * The declaration names its parts: the rules (`PushPuzzle`), what its view and input are made from
 * on each attach (`uses`: the app's audio, its sounds for the cue table and the loaded sheet), the
 * view, a sprite view and a sound view over the same run, and the input, the player's controls.
 */
import { AudioSystem } from "arcadekit/audio";
import * as Game from "arcadekit/game/browser";

import { PushPuzzle } from "../simulation";
import { PushPuzzleCueTable } from "./cue-table";
import * as Controls from "./internal/controls";
import * as SoundView from "./internal/sound-view";
import * as SpriteView from "./internal/sprite-view";
import { PushPuzzleSheet } from "./sheet";

/**
 * The push-puzzle genre in the browser: its rules, a view that draws them from the app's sheet and
 * plays their cues with the sounds the app gives its cue table, through the app's audio system,
 * and its input, from the keyboard, a gamepad or a swipe.
 *
 * **When to use**
 *
 * In an app: provide it with `PushPuzzleEngine.layer`, keep it attached to the viewport, and drive
 * it from Commands with `const engine = yield* PushPuzzleEngine`, then `engine.start(config)`,
 * `engine.setPaused(paused)` and `engine.stop`.
 *
 * **Details**
 *
 * Its layer needs the app's `PushPuzzleSheet`, `AudioSystem.AudioSystem` and `PushPuzzleCueTable`
 * (a test provides `AudioSystem.layerSilent` and a test sheet), and building it loads nothing.
 * Each attach loads the sheet, or takes the one already loaded. An attach fails when the sheet
 * can't be loaded or the browser has no WebGL.
 *
 * **Example** (The engine's key and its rules)
 *
 * ```ts
 * import { PushPuzzle } from "@arcadekit/push-puzzle";
 * import { PushPuzzleEngine } from "@arcadekit/push-puzzle/browser";
 *
 * PushPuzzleEngine.key; // => "arcadekit/game/Engine/PushPuzzleEngine"
 * PushPuzzleEngine.simulation === PushPuzzle; // => true
 * ```
 *
 * @category declarations
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
      SpriteView.make(container, sheet),
      SoundView.make(audio, sounds)
    ),
  input: Controls.make,
}) {}
