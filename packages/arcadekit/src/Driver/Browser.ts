/**
 * A page's display, for the frame loop to follow. This is the package's
 * `arcadekit/Driver/Browser` entry, for a program that runs in a page.
 *
 *   import * as DriverBrowser from "arcadekit/Driver/Browser"
 *
 *   App.run(...).pipe(Effect.provide(DriverBrowser.layer))
 *
 * `runMain` of `arcadekit/App/Browser` provides it, with the page's devices.
 */
import { Layer } from "effect";

import * as Driver from "../Driver";

/**
 * A page's screen: a frame is due once per repaint
 * (`requestAnimationFrame`), and nobody can see the game while the
 * document is hidden. It holds nothing.
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
 * The page's display, as the one a frame loop follows (`Driver.Display`):
 * `Driver.frames` and `App.run` then run once per repaint, and pause while
 * the tab is hidden.
 */
export const layer: Layer.Layer<never> = Layer.succeed(
  Driver.Display,
  display
) as Layer.Layer<never>;
