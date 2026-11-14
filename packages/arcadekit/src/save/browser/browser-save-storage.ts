/**
 * Browser save storage: where a save and a setting are kept in a browser, its localStorage, or
 * memory for the session where the browser refuses it.
 *
 * A declaration's `layer` takes a `KeyValueStore`, Effect's, and this module gives the one a
 * browser app provides. It is in an entry of its own, since localStorage is a browser's and the
 * root entry is checked with no DOM types.
 *
 * @since 0.7.0
 */
import * as BrowserKeyValueStore from "@effect/platform-browser/BrowserKeyValueStore";
import { Effect, Layer } from "effect";
import { KeyValueStore } from "effect/persistence";

/**
 * The browser's localStorage, as the `KeyValueStore` a save's and a setting's `layer` take. If the
 * browser won't give access to it, the values live in memory for this session instead, with a
 * warning, so the app still loads.
 *
 * **When to use**
 *
 * In a browser app, under the layers of its saves and settings, once: they then share one store.
 * A test provides `KeyValueStore.layerMemory` instead, and never touches localStorage.
 *
 * **Details**
 *
 * A browser that refuses localStorage (an embedded page with its site data blocked) throws when
 * the page reads it, and Effect's localStorage layer reports the throw as a defect: this layer
 * catches it as it is built and is memory from then on. A browser that gives localStorage and
 * refuses a write (a full quota) fails that write alone, which the save or setting logs.
 *
 * **Example** (A save kept in localStorage)
 *
 * ```ts
 * import { Save } from "arcadekit/save";
 * import { BrowserSaveStorage } from "arcadekit/save/browser";
 * import { Effect, Layer, Schema } from "effect";
 *
 * class RaceSave extends Save("RaceSave", {
 *   storageKey: "my-studio/race/save",
 *   record: Schema.Struct({ bestLap: Schema.Number }),
 *   mergeRecord: (a, b) => (a.bestLap <= b.bestLap ? a : b),
 * }) {}
 *
 * const layer = RaceSave.layer.pipe(Layer.provide(BrowserSaveStorage.layer));
 * const lap = Effect.gen(function* () {
 *   return yield* (yield* RaceSave).write({ oval: { bestLap: 61.2 } });
 * });
 * Effect.runSync(lap.pipe(Effect.provide(layer)));
 * localStorage.getItem("my-studio/race/save"); // => '{"version":1,"records":{"oval":{"bestLap":61.2}}}'
 * ```
 *
 * @category layers
 * @since 0.7.0
 */
export const layer: Layer.Layer<KeyValueStore.KeyValueStore> =
  BrowserKeyValueStore.layerLocalStorage.pipe(
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
