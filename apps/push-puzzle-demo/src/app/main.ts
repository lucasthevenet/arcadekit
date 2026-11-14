import { PushPuzzleContent } from "@arcadekit/push-puzzle";
import {
  PushPuzzleCueTable,
  PushPuzzleEngine,
  PushPuzzleSheet,
} from "@arcadekit/push-puzzle/browser";
import { BrowserAudioSystem } from "arcadekit/audio/browser";
import { FetchContentSource } from "arcadekit/content/browser";
import { loadSpriteSheet } from "arcadekit/render-three";
import { BrowserSaveStorage } from "arcadekit/save/browser";
import { Layer } from "effect";

import { CUE_SOUNDS, PushPuzzleAudioSettings } from "./audio";
import { PushPuzzleSave } from "./save";
import { SHEET_URL } from "./sprites";

export { Model } from "./model";
export { init, update } from "./update";
export { view } from "./view";
export { subscriptions } from "./subscriptions";

/**
 * What the genre's engine is made from, which this app owns: its sheet, its sounds for the
 * genre's cue table and its audio, which makes no AudioContext until the player's first gesture
 * (ADR-0015).
 */
const assets = Layer.mergeAll(
  PushPuzzleSheet.layer(loadSpriteSheet(SHEET_URL)),
  PushPuzzleCueTable.layer(CUE_SOUNDS),
  BrowserAudioSystem.layer
);

/**
 * App-lifetime services, shared by every Command and Subscription. Building them fetches
 * nothing: LoadContent loads the levels and the sheet, and the app's end frees the sheet.
 */
export const resources = Layer.mergeAll(
  PushPuzzleEngine.layer,
  PushPuzzleContent.layer(
    FetchContentSource.fromUrl(`${import.meta.env.BASE_URL}content/`)
  ),
  Layer.mergeAll(PushPuzzleSave.layer, PushPuzzleAudioSettings.layer).pipe(
    Layer.provide(BrowserSaveStorage.layer)
  )
).pipe(Layer.provideMerge(assets));
