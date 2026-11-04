import { BrowserAudioLayer } from "@gamekit/audio/browser";
import { fetchJsonSource } from "@gamekit/content/browser";
import { makePushPuzzleContentLayer } from "@gamekit/push-puzzle";
import { makePushPuzzleEngineLayer } from "@gamekit/push-puzzle/browser";
import { BrowserSaveStorage } from "@gamekit/save/browser";
import { Layer } from "effect";

import { AudioSettingsLayer, CUE_SOUNDS } from "./audio";
import { SaveLayer } from "./save";
import { SpritesLayer } from "./sprites";

export { Model } from "./model";
export { init, update } from "./update";
export { view } from "./view";
export { subscriptions } from "./subscriptions";

/** App-lifetime services, shared by every Command and Subscription. */
export const resources = Layer.mergeAll(
  // The engine plays its sounds through the app's Audio, which makes no AudioContext
  // until the player's first gesture, and draws from the app's sheet, loaded here once.
  makePushPuzzleEngineLayer(CUE_SOUNDS).pipe(
    Layer.provideMerge(Layer.mergeAll(BrowserAudioLayer, SpritesLayer))
  ),
  makePushPuzzleContentLayer(
    fetchJsonSource(`${import.meta.env.BASE_URL}content/`)
  ),
  Layer.mergeAll(SaveLayer, AudioSettingsLayer).pipe(
    Layer.provide(BrowserSaveStorage)
  )
);
