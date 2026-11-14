import { SurvivorsContent } from "@arcadekit/survivors";
import {
  SurvivorsCueTable,
  SurvivorsEngine,
  SurvivorsSheet,
} from "@arcadekit/survivors/browser";
import { BrowserAudioSystem } from "arcadekit/audio/browser";
import { FetchContentSource } from "arcadekit/content/browser";
import { loadSpriteSheet } from "arcadekit/render-three";
import { BrowserSaveStorage } from "arcadekit/save/browser";
import { Layer } from "effect";

import { BrowserRoomsLayer } from "../coop/config";
import { CoopLayer } from "./coop";
import { SurvivorsSave } from "./save";
import { SurvivorsAudioSettings, survivorsSounds } from "./sound";

export { Model } from "./model";
export { init, update } from "./update";
export { view } from "./view";
export { subscriptions } from "./subscriptions";

/**
 * What the genre's engine is made from, which this app owns: its sprite sheet, its sounds for
 * the genre's cue table and its audio, which makes no AudioContext until the player's first
 * gesture (ADR-0015). Co-op plays the same engine, so it takes them from here too: one Layer
 * value, so both draw from one sheet, loaded once.
 */
const assets = Layer.mergeAll(
  SurvivorsSheet.layer(
    loadSpriteSheet(`${import.meta.env.BASE_URL}sprites/survivors.json`)
  ),
  SurvivorsCueTable.layer(survivorsSounds),
  BrowserAudioSystem.layer
);

/**
 * The content, loaded once: the Commands and the co-op client, which loads a run's content
 * itself, share one load.
 */
const ContentLayer = SurvivorsContent.layer(
  FetchContentSource.fromUrl(`${import.meta.env.BASE_URL}content/`)
);

/**
 * App-lifetime services, shared by every Command and Subscription. Building them fetches
 * nothing: LoadContent loads the content and the sheet, and the app's end frees the sheet and
 * leaves co-op.
 */
export const resources = Layer.mergeAll(
  SurvivorsEngine.layer,
  SurvivorsSave.layer.pipe(Layer.provide(BrowserSaveStorage.layer)),
  SurvivorsAudioSettings.layer.pipe(Layer.provide(BrowserSaveStorage.layer)),
  // Co-op's rooms are on the signalling worker that serves the page.
  CoopLayer.pipe(Layer.provide(BrowserRoomsLayer))
).pipe(Layer.provideMerge(ContentLayer), Layer.provideMerge(assets));
