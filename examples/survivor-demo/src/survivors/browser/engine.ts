/**
 * Survivors' engine, declared: the genre as the browser runs it, for one player, and as
 * `SurvivorsCoop` plays it for several.
 *
 * The declaration names its parts: the rules (`Survivors`), what its view and input are made from
 * on each attach (`uses`: the app's audio, its sounds for the cue table and the loaded sheet), the
 * view, a sprite view and a sound view over the same run that both follow the local player's
 * hero, and the input, the player's controls at slot 0.
 */
import { AudioSystem } from "arcadekit/audio";
import * as Game from "arcadekit/game/browser";

import { Survivors } from "../simulation";
import { SurvivorsCueTable } from "./cue-table";
import * as Controls from "./internal/controls";
import * as SoundView from "./internal/sound-view";
import * as SpriteView from "./internal/sprite-view";
import { SurvivorsSheet } from "./sheet";

/**
 * The survivors genre in the browser: its rules, a view that draws them from the app's sheet and
 * plays their cues with the sounds the app gives its cue table, through the app's audio system,
 * and its input, from the keyboard, a gamepad or a drag.
 *
 * **When to use**
 *
 * In an app: provide it with `SurvivorsEngine.layer`, keep it attached to the viewport, and drive
 * it from Commands with `const engine = yield* SurvivorsEngine`, then `engine.start(config)`,
 * `engine.send(command)`, `engine.setPaused(paused)` and `engine.stop`. A co-op app plays it
 * through `SurvivorsCoop`.
 *
 * **Details**
 *
 * Building the layer loads nothing. Each attach loads the sheet, or takes the one already loaded,
 * and needs the app's `AudioSystem.AudioSystem` and `SurvivorsCueTable` (a test provides
 * `AudioSystem.layerSilent`). The view reads the local player's slot on every frame: slot 0 for
 * one player, the lobby's slot in co-op. An attach fails when the sheet can't be loaded or the
 * browser has no WebGL.
 *
 * **Example** (The engine's key and its rules)
 *
 * ```ts
 * import { Survivors } from "../survivors/index";
 * import { SurvivorsEngine } from "../survivors/browser/index";
 *
 * SurvivorsEngine.key; // => "arcadekit/game/Engine/SurvivorsEngine"
 * SurvivorsEngine.simulation === Survivors; // => true
 * ```
 *
 * @category declarations
 */
export class SurvivorsEngine extends Game.Engine("SurvivorsEngine", {
  simulation: Survivors,
  uses: {
    audio: AudioSystem.AudioSystem,
    sounds: SurvivorsCueTable,
    sheet: SurvivorsSheet.load,
  },
  view: (container, { audio, sounds, sheet }, { local }) =>
    Game.combineViews(
      SpriteView.make(container, sheet, { localHero: () => local.slot }),
      SoundView.make(audio, sounds, { localHero: () => local.slot })
    ),
  input: Controls.makeSolo,
}) {}
