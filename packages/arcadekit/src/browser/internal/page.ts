import { Effect, Layer } from "effect";

import * as Assets from "../../Assets.ts";
import * as Driver from "../../Driver.ts";
import * as Input from "../../Input.ts";
import { fetching, fetchingFrom } from "../../internal/fetching.ts";
import type { Options } from "../Browser.ts";
import { layerSound } from "./audio.ts";
import { listen } from "./devices.ts";

/**
 * The page's display, `Browser.display`.
 *
 * @internal
 */
export const display: Driver.DisplayShape = {
  request(callback) {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  },
  hidden: () => document.visibilityState === "hidden",
  onVisibilityChange(listener) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

/**
 * The page's display and devices, and its sound unless `sounds` is `false`:
 * `Browser.layer`.
 *
 * @internal
 */
export const layer = (options: Options): Layer.Layer<never> => {
  // A path is read against the document's base, as `fetch` reads it, where
  // HttpClient reads it against the page's address. A loader of the game's
  // own, provided around this layer, is kept.
  const loader = Layer.effect(
    Assets.Loader,
    Effect.map(Assets.Loader, (given) =>
      given === fetching
        ? fetchingFrom((url) => new URL(url, document.baseURI).href)
        : given
    )
  );
  const page = Layer.mergeAll(
    loader,
    Driver.layer(display),
    Layer.succeed(Input.Source, {
      listen: Effect.map(
        Effect.acquireRelease(
          Effect.sync(() => listen(options)),
          (listening) => Effect.sync(listening.stop)
        ),
        (listening) => listening.listener
      ),
    })
  ) as Layer.Layer<never>;
  return options.sounds === false
    ? page
    : Layer.merge(
        page,
        // Its sound sleeps while the page's own document is hidden.
        Layer.provide(
          layerSound(options.sounds ?? [], options),
          Layer.merge(Driver.layer(display), loader)
        )
      );
};
