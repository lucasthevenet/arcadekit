import { BrowserAudioSystem } from "arcadekit/audio/browser";
import { FetchContentSource } from "arcadekit/content/browser";
import { CoopRooms } from "arcadekit/net/browser";
import { SpriteSheet } from "arcadekit/render-three";
import { BrowserSaveStorage } from "arcadekit/save/browser";
import { Layer } from "effect";

/**
 * The app as Foldkit runs it: its Model, `init`, `update`, `view` and `subscriptions`, and the
 * `resources` its Commands and Subscriptions run against, which `src/entry.ts` hands to
 * `Runtime.makeApplication`.
 */
import { SurvivorsContent } from "#survivors";
import {
  SurvivorsCoop,
  SurvivorsCueTable,
  SurvivorsEngine,
  SurvivorsSheet,
} from "#survivors/browser";

import { SurvivorsAudioSettings } from "./audio-settings";
import * as CoopDebug from "./coop-debug";
import * as Rooms from "./rooms";
import { SurvivorsSave } from "./save";
import * as Sheet from "./sheet";
import * as Sounds from "./sounds";

export { Model } from "./model";
export { init, update } from "./update";
export { view } from "./view";
export { subscriptions } from "./subscriptions";

/**
 * What the genre's engine is made from, which this app owns: its sprite sheet, its sounds for
 * the genre's cue table and its audio, which makes no AudioContext until the player's first
 * gesture. Co-op plays the same engine, so it takes them from here too: one Layer value, so both
 * draw from one sheet, loaded once.
 */
const assets = Layer.mergeAll(
  SurvivorsSheet.layer(SpriteSheet.fromUrl(Sheet.url)),
  SurvivorsCueTable.layer(Sounds.byCue),
  BrowserAudioSystem.layer
);

/**
 * The content, loaded once: the Commands and the co-op client, which loads a run's content
 * itself, share one load.
 */
const content = SurvivorsContent.layer(
  FetchContentSource.fromUrl(`${import.meta.env.BASE_URL}content/`)
);

/** Co-op's rooms: the signalling worker that serves the page, and the STUN servers (`Rooms`). */
const rooms = CoopRooms.layer(() => ({
  url: Rooms.url(),
  iceServers: Rooms.iceServers(),
}));

/**
 * App-lifetime services, shared by every Command and Subscription. Building them fetches
 * nothing: LoadContent loads the content and the sheet, and the app's end frees the sheet and
 * leaves co-op.
 */
export const resources = Layer.mergeAll(
  SurvivorsEngine.layer,
  Layer.mergeAll(SurvivorsSave.layer, SurvivorsAudioSettings.layer).pipe(
    Layer.provide(BrowserSaveStorage.layer)
  ),
  // The genre's Co-op client over the app's rooms, with its debug read on a global in
  // development. It plays its sounds through the app's audio system, loads a run's content from
  // `SurvivorsContent` and draws from `SurvivorsSheet`, as the engine does.
  CoopDebug.layer.pipe(
    Layer.provideMerge(SurvivorsCoop.layer),
    Layer.provide(rooms)
  )
).pipe(Layer.provideMerge(content), Layer.provideMerge(assets));
