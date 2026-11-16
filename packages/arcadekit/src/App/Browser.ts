/**
 * Starting a game in a page. This is the package's `arcadekit/App/Browser`
 * entry, and the only one that imports a browser package.
 *
 *   import * as App from "arcadekit/App"
 *   import * as AppBrowser from "arcadekit/App/Browser"
 *
 *   AppBrowser.runMain(App.run({ plugins: [Game] }, { hz: 60 }), {
 *     target: canvas,
 *     preventDefault: ["Space", "ArrowUp", "ArrowDown"],
 *   })
 *
 * It is the platform's `runMain` around the game, with the page's display
 * (`arcadekit/Driver/Browser`) and its devices (`arcadekit/Input/Browser`)
 * provided to the whole of it: the frame loop follows
 * `requestAnimationFrame`, the input stage hears the keyboard, the pointer
 * and the gamepads, and when the page goes away the game is interrupted
 * and everything is let go.
 */
import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { Effect, Layer } from "effect";
import type { Runtime } from "effect";

import * as DriverBrowser from "../Driver/Browser";
import * as InputBrowser from "../Input/Browser";

/** What `runMain` takes: where the page's devices are heard, and how the program ends. */
export interface Options extends InputBrowser.Options {
  /** Leaves a failure unreported. */
  readonly disableErrorReporting?: boolean;
  /** What to do when the game has ended, in place of nothing. */
  readonly teardown?: Runtime.Teardown;
}

/**
 * Starts a game in a page: `BrowserRuntime.runMain` around the game, with
 * the page's display and its devices provided to the whole of it.
 *
 *   AppBrowser.runMain(App.run({ plugins: [Game] }, { hz: 60 }), { target: canvas })
 *
 * - The game is whatever needs nothing more from outside: provide the
 *   game's own services to it first, and a missing one is a compile error
 *   here.
 * - A failure is reported through Effect's logger.
 * - When the page goes away for good (`pagehide`, and not into the
 *   back/forward cache) the game is interrupted: the frame loop stops, the
 *   app's scope closes, and the page is no longer listened to.
 */
export const runMain = <A, E>(
  game: Effect.Effect<A, E>,
  options: Options = {}
): void =>
  BrowserRuntime.runMain(
    Effect.provide(
      game,
      Layer.merge(DriverBrowser.layer, InputBrowser.layer(options))
    ),
    {
      disableErrorReporting: options.disableErrorReporting,
      teardown: options.teardown,
    }
  );
