import { fetchJsonSource } from "@gamekit/content/browser";
import { BrowserSaveStorage } from "@gamekit/save/browser";
import { makeSurvivorsContentLayer } from "@gamekit/survivors";
import { SurvivorsEngineLayer } from "@gamekit/survivors/browser";
import { Layer } from "effect";

import { CoopLayer } from "./coop";
import { SaveLayer } from "./save";

export { Model } from "./model";
export { init, update } from "./update";
export { view } from "./view";
export { subscriptions } from "./subscriptions";

/** App-lifetime services, shared by every Command and Subscription. */
export const resources = Layer.mergeAll(
  SurvivorsEngineLayer,
  makeSurvivorsContentLayer(
    fetchJsonSource(`${import.meta.env.BASE_URL}content/`)
  ),
  SaveLayer.pipe(Layer.provide(BrowserSaveStorage)),
  CoopLayer
);
