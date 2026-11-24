/**
 * Everything that only a page can use: its display, its input devices, its
 * images and sound, and the way a program starts in it. `arcadekit/Browser`
 * is the only entry point that imports a browser package, so a server, a
 * replay or a test of the game imports `arcadekit` alone.
 *
 *   import { App, Driver } from "arcadekit"
 *   import * as Browser from "arcadekit/Browser"
 *
 *   Browser.runMain(Driver.run(App.define({ plugins: [Game] }), { hz: 60 }), {
 *     target: canvas,
 *     preventDefault: ["Space", "ArrowUp", "ArrowDown"],
 *   })
 *
 * `Browser.runMain` runs the game with the platform's `runMain`, and provides
 * the page's display and devices to the whole program. The frame loop
 * follows `requestAnimationFrame`, and the input stage reads the keyboard,
 * the pointer and gamepads. When the page closes, the game is interrupted and
 * everything it holds is released.
 */
import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { Effect, Layer } from "effect";
import type { Runtime } from "effect";

import * as Assets from "./Assets";
import { layerSound } from "./browser/audio";
import { listen } from "./browser/devices";
import type { Options } from "./browser/options";
import * as Driver from "./Driver";
import * as Input from "./Input";

export { layerSound } from "./browser/audio";
export { image, sound, stream } from "./browser/media";
export type {
  AudioLike,
  GamepadLike,
  MediaLike,
  Options,
  PointerTarget,
} from "./browser/options";

/**
 * A page's display, on which a frame is due once per repaint, with
 * `requestAnimationFrame`, and the game is hidden while the document is. It
 * holds no state.
 *
 * @category Services
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
 * Returns a layer that provides a page's display and input devices to a whole
 * program.
 *
 * **Details**
 *
 * - The frame loop follows `requestAnimationFrame`, and pauses while the
 *   document is hidden.
 * - A key's code is its `KeyboardEvent.code`. A held key counts as pressed
 *   once, and every key and pointer button is released when the page loses
 *   focus.
 * - The pointer is a mouse, a pen or a finger. `PointerX` and `PointerY` are
 *   CSS pixels from the top-left of `target`. Presses are detected on `target`,
 *   and moves and releases anywhere on the page.
 * - Mouse buttons held together are tracked individually, even though the page
 *   reports every press but the first, and every release but the last, as
 *   moves.
 * - Gamepads are read when the input stage samples the devices, once before
 *   each tick. Unplugging one releases all its inputs.
 * - An asset's path is read against the document's base, its `<base href>`,
 *   as `fetch` reads it, unless a loader of the game's own, such as
 *   `Assets.layerMemory`, is provided around this layer.
 * - Each app listens to the devices for itself, from when `App.make` makes
 *   the app until the app is closed, wherever the layer is provided. Reading
 *   the devices after the app is closed throws, with an error that says so.
 * - Unless `sounds` is `false`, its sound is that of `Browser.layerSound`.
 *   `Sound.plugin` opens it when the app is made, wherever the layer is
 *   provided, and keeps it open until the app is closed. The apps made under
 *   the layer share it.
 *
 * @category Layers
 */
export const layer = (options: Options = {}): Layer.Layer<never> => {
  // A path is read against the document's base, as `fetch` reads it, where
  // HttpClient reads it against the page's address. A loader of the game's
  // own, provided around this layer, is kept.
  const loader = Layer.effect(
    Assets.Loader,
    Effect.map(Assets.Loader, (given) =>
      given === Assets.fetching
        ? Assets.fetchingFrom((url) => new URL(url, document.baseURI).href)
        : given
    )
  );
  const page = Layer.mergeAll(
    loader,
    Layer.succeed(Driver.Display, display),
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
          layerSound(options.sounds ?? {}, options),
          Layer.merge(Layer.succeed(Driver.Display, display), loader)
        )
      );
};

/**
 * Runs a game in a page, with the platform's `runMain`,
 * `BrowserRuntime.runMain`, and with `Browser.layer(options)` provided to the
 * whole program.
 *
 *   Browser.runMain(Driver.run(App.define({ plugins: [Game] }), { hz: 60 }), { target: canvas })
 *
 * **Details**
 *
 * - The game must have no remaining requirements. Provide your game's own
 *   services to it first, since a missing one is a compile error here.
 * - A failure is reported through Effect's logger.
 * - When the page is closed for good, on a `pagehide` that doesn't enter the
 *   browser's back-forward cache, the game is interrupted. The frame loop
 *   stops, `Driver.run` closes the app, and the page is no longer listened
 *   to.
 *
 * @category Running
 */
export const runMain = <A, E>(
  game: Effect.Effect<A, E>,
  options: Options & {
    /** Disables error reporting. */
    readonly disableErrorReporting?: boolean;
    /** What to do when the game ends. Defaults to nothing. */
    readonly teardown?: Runtime.Teardown;
  } = {}
): void =>
  BrowserRuntime.runMain(Effect.provide(game, layer(options)), {
    disableErrorReporting: options.disableErrorReporting,
    teardown: options.teardown,
  });
