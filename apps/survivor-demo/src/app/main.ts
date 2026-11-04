import { BrowserAudioLayer } from "@gamekit/audio/browser";
import { fetchJsonSource } from "@gamekit/content/browser";
import { BrowserSaveStorage } from "@gamekit/save/browser";
import { makeSurvivorsContentLayer } from "@gamekit/survivors";
import { makeSurvivorsEngineLayer } from "@gamekit/survivors/browser";
import { Layer } from "effect";

import { currentVariant } from "../prototype-art";
import { CoopLayer } from "./coop";
import { SaveLayer } from "./save";
import { SoundSettingsLayer, survivorsSounds } from "./sound";

// PROTOTYPE (#24 art): the art variant ?art=<key> picks, if any.
const artVariant = currentVariant;

export { Model } from "./model";
export { init, update } from "./update";
export { view } from "./view";
export { subscriptions } from "./subscriptions";

/**
 * App-lifetime services, shared by every Command and Subscription. The engine and the co-op
 * client play through the one audio system, which makes no AudioContext before the first
 * gesture.
 */
export const resources = Layer.mergeAll(
  // PROTOTYPE (#24 art): ?art=<key> draws with another art variant.
  makeSurvivorsEngineLayer(
    survivorsSounds,
    artVariant === undefined
      ? undefined
      : (container) => artVariant.makeView(container, {})
  ),
  makeSurvivorsContentLayer(
    fetchJsonSource(`${import.meta.env.BASE_URL}content/`)
  ),
  SaveLayer.pipe(Layer.provide(BrowserSaveStorage)),
  SoundSettingsLayer.pipe(Layer.provide(BrowserSaveStorage)),
  CoopLayer
).pipe(Layer.provideMerge(BrowserAudioLayer));
