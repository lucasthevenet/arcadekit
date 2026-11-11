import { Audio } from "arcadekit/audio";
import type { AudioSystem } from "arcadekit/audio";
import { Asset } from "arcadekit/content";
import * as Game from "arcadekit/game/browser";
import type { SpriteSheet, SpriteSheetError } from "arcadekit/render-three";

import type { SurvivorsInput } from "../input";
import { Survivors } from "../simulation";
import type { World } from "../world";
import type { SurvivorsArt } from "./art";
import { heroDevice } from "./device";
import { SurvivorsCueTable, SurvivorsSoundView } from "./sound";
import type { SurvivorsSounds } from "./sound";
import { SurvivorsView } from "./view";

/**
 * What a survivors game plays its sounds through: the app's audio system, and the sounds the
 * app gives `SurvivorsCueTable`.
 */
export interface SurvivorsGameSound {
  readonly audio: AudioSystem;
  readonly sounds: SurvivorsSounds;
}

/**
 * A survivors run's views: the sprite view and, with `sound`, a sound view beside it. Both read
 * `localHero`, the local player's slot, on every frame; without it they follow slot 0.
 */
export const survivorsViews = (
  container: HTMLElement,
  art: SurvivorsArt,
  sound?: SurvivorsGameSound,
  localHero?: () => number
): Game.View<World> => {
  const options = localHero === undefined ? {} : { localHero };
  const view = new SurvivorsView(container, art, options);
  return sound === undefined
    ? view
    : Game.combineViews(view, new SurvivorsSoundView({ ...sound, ...options }));
};

/**
 * Reads a single-player run's step input from the player's devices on `surface` (keys, touch,
 * gamepad): they drive the first hero, and nobody leaves.
 */
export const survivorsInput = (
  surface: HTMLElement
): Game.InputSource<SurvivorsInput> => {
  const device = heroDevice(surface);
  return { ...Game.soloInput(device), dispose: device.dispose };
};

/**
 * The app's survivors sheet, with every tag the view draws for its content (`missingSpriteTags`
 * checks one; ADR-0015). The app says where it comes from,
 * `SurvivorsSheet.layer(loadSpriteSheet(url))`, and loads it on its loading screen; the engine
 * draws from it, for one player and in co-op, and never frees it. The app's end does.
 */
export class SurvivorsSheet extends Asset<SpriteSheet, SpriteSheetError>()(
  "SurvivorsSheet",
  { release: (sheet) => sheet.dispose() }
) {}

/**
 * The survivors genre in the browser, for one player: its rules, a view that draws them from
 * the app's sheet and plays their cues, with the sounds the app gives its cue table, through
 * the app's `Audio` (tests provide `SilentAudioLayer`), and its input. `SurvivorsEngine.layer`
 * provides the engine; building it loads nothing, and each attach loads the sheet, or takes
 * the one already loaded. The view follows the local player's hero, so `SurvivorsCoop` plays
 * this engine for several players.
 */
export class SurvivorsEngine extends Game.Engine("SurvivorsEngine", {
  simulation: Survivors,
  uses: {
    audio: Audio,
    sounds: SurvivorsCueTable,
    sheet: SurvivorsSheet.load,
  },
  view: (container, { audio, sounds, sheet }, { local }) =>
    survivorsViews(container, { sheet }, { audio, sounds }, () => local.slot),
  input: survivorsInput,
}) {}
