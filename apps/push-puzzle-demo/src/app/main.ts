import { BrowserAudioLayer } from "@arcadekit/audio/browser";
import { fetchJsonSource } from "@arcadekit/content/browser";
import { makePushPuzzleContentLayer } from "@arcadekit/push-puzzle";
import { makePushPuzzleEngineLayer } from "@arcadekit/push-puzzle/browser";
import { loadSpriteSheet } from "@arcadekit/render-three";
import { BrowserSaveStorage } from "@arcadekit/save/browser";
import { Layer } from "effect";

import { AudioSettingsLayer, CUE_SOUNDS } from "./audio";
import { SaveLayer } from "./save";
import { SHEET_URL } from "./sprites";

export { Model } from "./model";
export { init, update } from "./update";
export { view } from "./view";
export { subscriptions } from "./subscriptions";

/**
 * App-lifetime services, shared by every Command and Subscription. Building them fetches
 * nothing; the app's end frees the sheet.
 */
export const resources = Layer.mergeAll(
  // The engine plays its sounds through the app's Audio, which makes no AudioContext until the
  // player's first gesture, and is made from the app's sheet, which LoadContent loads once
  // (ADR-0015).
  makePushPuzzleEngineLayer({
    sheet: loadSpriteSheet(SHEET_URL),
    sounds: CUE_SOUNDS,
  }).pipe(Layer.provideMerge(BrowserAudioLayer)),
  makePushPuzzleContentLayer(
    fetchJsonSource(`${import.meta.env.BASE_URL}content/`)
  ),
  Layer.mergeAll(SaveLayer, AudioSettingsLayer).pipe(
    Layer.provide(BrowserSaveStorage)
  )
);
