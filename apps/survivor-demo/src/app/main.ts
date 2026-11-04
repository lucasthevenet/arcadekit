import { BrowserAudioLayer } from "@gamekit/audio/browser";
import { fetchJsonSource } from "@gamekit/content/browser";
import { loadSpriteSheet } from "@gamekit/render-three";
import { BrowserSaveStorage } from "@gamekit/save/browser";
import { makeSurvivorsContentLayer } from "@gamekit/survivors";
import { makeSurvivorsEngineLayer } from "@gamekit/survivors/browser";
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
 * App-lifetime services, shared by every Command and Subscription. The engine and the co-op
 * client play through the one audio system, which makes no AudioContext before the first
 * gesture, and draw from the one sprite sheet, which LoadContent loads with the content.
 * Building them fetches nothing; the app's end frees the sheet.
 */
export const resources = Layer.mergeAll(
  makeSurvivorsContentLayer(
    fetchJsonSource(`${import.meta.env.BASE_URL}content/`)
  ),
  SaveLayer.pipe(Layer.provide(BrowserSaveStorage)),
  SoundSettingsLayer.pipe(Layer.provide(BrowserSaveStorage)),
  CoopLayer
).pipe(Layer.provideMerge(EngineLayer), Layer.provideMerge(BrowserAudioLayer));
