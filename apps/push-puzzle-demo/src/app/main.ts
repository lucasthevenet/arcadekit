import { PushPuzzleContent } from "@arcadekit/push-puzzle";
import {
  PushPuzzleCueSounds,
  PushPuzzleEngine,
  PushPuzzleSheet,
} from "@arcadekit/push-puzzle/browser";
import { BrowserAudioLayer } from "arcadekit/audio/browser";
import { fetchJsonSource } from "arcadekit/content/browser";
import { loadSpriteSheet } from "arcadekit/render-three";
import { BrowserSaveStorage } from "arcadekit/save/browser";
import { Layer } from "effect";

import { AudioSettingsLayer, CUE_SOUNDS } from "./audio";
import { SaveLayer } from "./save";
import { SHEET_URL } from "./sprites";

export { Model } from "./model";
export { init, update } from "./update";
export { view } from "./view";
export { subscriptions } from "./subscriptions";

/**
 * What the genre's engine is made from, which this app owns: its sheet, its cue table and its
 * audio, which makes no AudioContext until the player's first gesture (ADR-0015).
 */
const assets = Layer.mergeAll(
  PushPuzzleSheet.layer(loadSpriteSheet(SHEET_URL)),
  Layer.succeed(PushPuzzleCueSounds, CUE_SOUNDS),
  BrowserAudioLayer
);

/**
 * App-lifetime services, shared by every Command and Subscription. Building them fetches
 * nothing: LoadContent loads the levels and the sheet, and the app's end frees the sheet.
 */
export const resources = Layer.mergeAll(
  PushPuzzleEngine.layer,
  PushPuzzleContent.layer(
    fetchJsonSource(`${import.meta.env.BASE_URL}content/`)
  ),
  Layer.mergeAll(SaveLayer, AudioSettingsLayer).pipe(
    Layer.provide(BrowserSaveStorage)
  )
).pipe(Layer.provideMerge(assets));
