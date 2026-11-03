import * as BrowserKeyValueStore from "@effect/platform-browser/BrowserKeyValueStore";
import { Effect, Layer } from "effect";
import { KeyValueStore } from "effect/persistence";

// Storage that needs a browser. Kept out of the root entry so the save logic
// can be checked and tested without DOM types.

/**
 * The browser's localStorage. If the browser won't give access to it, the
 * save lives in memory for this session instead, so the app still loads.
 */
export const BrowserSaveStorage = BrowserKeyValueStore.layerLocalStorage.pipe(
  Layer.catchCause((cause) =>
    Layer.merge(
      KeyValueStore.layerMemory,
      Layer.effectDiscard(
        Effect.logWarning(
          "localStorage isn't available. Saved progress lasts this session only.",
          cause
        )
      )
    )
  )
);
