import { makeSurvivorsContentLayer } from "@arcadekit/survivors";
import { makeSurvivorsEngineLayer } from "@arcadekit/survivors/browser";
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
 * The engine, through the load of the app's sprite sheet (ADR-0015). One Layer value, so the
 * Commands, the engine entry and the co-op client share one loader, and so one sheet.
 */
const EngineLayer = makeSurvivorsEngineLayer({
  sheet: loadSpriteSheet(`${import.meta.env.BASE_URL}sprites/survivors.json`),
  sounds: survivorsSounds,
});

/**
 * The content, loaded once: the Commands and the co-op client, which loads a run's content
 * itself, share one loader.
 */
const ContentLayer = makeSurvivorsContentLayer(
  fetchJsonSource(`${import.meta.env.BASE_URL}content/`)
);

/**
 * App-lifetime services, shared by every Command and Subscription. The engine and the co-op
 * client play through the one audio system, which makes no AudioContext before the first
 * gesture, and draw from the one sprite sheet, which LoadContent loads with the content.
 * Building them fetches nothing; the app's end frees the sheet and leaves co-op.
 */
export const resources = Layer.mergeAll(
  SaveLayer.pipe(Layer.provide(BrowserSaveStorage)),
  SoundSettingsLayer.pipe(Layer.provide(BrowserSaveStorage)),
  CoopLayer
).pipe(
  Layer.provideMerge(ContentLayer),
  Layer.provideMerge(EngineLayer),
  Layer.provideMerge(BrowserAudioLayer)
);
