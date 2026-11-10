import { SurvivorsContent } from "@arcadekit/survivors";
import {
  SurvivorsCueSounds,
  SurvivorsEngine,
  SurvivorsSheet,
} from "@arcadekit/survivors/browser";
import { BrowserAudioLayer } from "arcadekit/audio/browser";
import { fetchJsonSource } from "arcadekit/content/browser";
import { loadSpriteSheet } from "arcadekit/render-three";
import { BrowserSaveStorage } from "arcadekit/save/browser";
import { Layer } from "effect";

import { CoopLayer } from "./coop";
import { SaveLayer } from "./save";
import { SoundSettingsLayer, survivorsSounds } from "./sound";

export { Model } from "./model";
export { init, update } from "./update";
export { view } from "./view";
export { subscriptions } from "./subscriptions";

/**
 * What the genre's engine is made from, which this app owns: its sprite sheet, its cue table and
 * its audio, which makes no AudioContext until the player's first gesture (ADR-0015). The co-op
 * client takes the sheet and the audio from here too: one Layer value, so both draw from one
 * sheet, loaded once.
 */
const assets = Layer.mergeAll(
  SurvivorsSheet.layer(
    loadSpriteSheet(`${import.meta.env.BASE_URL}sprites/survivors.json`)
  ),
  Layer.succeed(SurvivorsCueSounds, survivorsSounds),
  BrowserAudioLayer
);

/**
 * The content, loaded once: the Commands and the co-op client, which loads a run's content
 * itself, share one load.
 */
const ContentLayer = SurvivorsContent.layer(
  fetchJsonSource(`${import.meta.env.BASE_URL}content/`)
);

/**
 * App-lifetime services, shared by every Command and Subscription. Building them fetches
 * nothing: LoadContent loads the content and the sheet, and the app's end frees the sheet and
 * leaves co-op.
 */
export const resources = Layer.mergeAll(
  SurvivorsEngine.layer,
  SaveLayer.pipe(Layer.provide(BrowserSaveStorage)),
  SoundSettingsLayer.pipe(Layer.provide(BrowserSaveStorage)),
  CoopLayer
).pipe(Layer.provideMerge(ContentLayer), Layer.provideMerge(assets));
