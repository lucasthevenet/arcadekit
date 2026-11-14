import { BrowserAudioSystem } from "arcadekit/audio/browser";
import { FetchContentSource } from "arcadekit/content/browser";
import { SpriteSheet } from "arcadekit/render-three";
import { BrowserSaveStorage } from "arcadekit/save/browser";
import { Layer } from "effect";

/**
 * The app as Foldkit runs it: its Model, `init`, `update`, `view` and `subscriptions`, and the
 * `resources` its Commands and Subscriptions run against, which `src/entry.ts` hands to
 * `Runtime.makeApplication`.
 */
import { PushPuzzleContent } from "#push-puzzle";
import {
  PushPuzzleCueTable,
  PushPuzzleEngine,
  PushPuzzleSheet,
} from "#push-puzzle/browser";

import { PushPuzzleAudioSettings } from "./audio-settings";
import { PushPuzzleSave } from "./save";
import * as Sheet from "./sheet";
import * as Sounds from "./sounds";

export { Model } from "./model";
export { init, update } from "./update";
export { view } from "./view";
export { subscriptions } from "./subscriptions";

/**
 * What the genre's engine is made from, which this app owns: its sheet, its sounds for the
 * genre's cue table and its audio, which makes no AudioContext until the player's first gesture.
 */
const assets = Layer.mergeAll(
  PushPuzzleSheet.layer(SpriteSheet.fromUrl(Sheet.url)),
  PushPuzzleCueTable.layer(Sounds.byCue),
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
