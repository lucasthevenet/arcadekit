import { fetchJsonSource } from "@gamekit/content/browser";
import { makePushPuzzleContentLayer } from "@gamekit/push-puzzle";
import { PushPuzzleEngineLayer } from "@gamekit/push-puzzle/browser";
import { Layer } from "effect";

export { Model } from "./model";
export { init, update } from "./update";
export { view } from "./view";
export { subscriptions } from "./subscriptions";

/** App-lifetime services, shared by every Command and Subscription. */
export const resources = Layer.mergeAll(
  PushPuzzleEngineLayer,
  makePushPuzzleContentLayer(
    fetchJsonSource(`${import.meta.env.BASE_URL}content/`)
  )
);
