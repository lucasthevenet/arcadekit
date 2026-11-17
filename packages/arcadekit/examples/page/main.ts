/**
 * A game in a page: stars fall at sixty ticks a second, a basket catches
 * them, and both are drawn on a canvas once per repaint.
 *
 * Enter starts the level, whose assets are loaded when it starts and let go
 * when it is left with Q. The arrow keys move the basket, and so does the
 * pointer while its button is held. P pauses the game. The buttons under
 * the canvas do what the keys do. A star caught makes a sound, which is
 * the level's, and while the game is played there is music, softer while
 * it is paused.
 *
 * The menu and the heads-up display are built twice, on the same bridge:
 * with the page's own DOM (ui-dom.ts), and with React (ui-react.ts), which
 * `?ui=react` shows.
 *
 *   pnpm --filter arcadekit page
 *
 * `?stream` plays the music as a stream.
 */
import { Effect } from "effect";

// In a game of your own these are "arcadekit/Browser" and "arcadekit".
import * as Browser from "../../src/Browser";
import { App, View } from "../../src/index";
import { Game, Screen } from "./game";

// --- the UI ----------------------------------------------------------------------
// The bridge is made here, handed to the UI, and provided to the game. The
// UI holds the bridge and nothing of the game; only the one that is shown
// is loaded.
const ui = View.makeBridge();
const { mount } =
  new URLSearchParams(location.search).get("ui") === "react"
    ? await import("./ui-react")
    : await import("./ui-dom");
mount(document.querySelector("#ui")!, ui);

// --- the entry point -------------------------------------------------------------
// App.run makes the app and runs it, sixty ticks a second, until it is
// interrupted. Browser.runMain starts it in the page: the frame loop follows
// the page's repaints, the page's devices are listened to, and when the page
// goes away the game is interrupted: the loop takes its frame request back,
// the app's scope closes, what was loaded is let go, and nobody listens any
// more.
Browser.runMain(
  App.run({ plugins: [Game], seed: Date.now() }, { hz: 60 }).pipe(
    Effect.provide(Screen.layer),
    Effect.provide(View.layer(ui))
  ),
  {
    target: document.querySelector("#game")!,
    preventDefault: ["ArrowLeft", "ArrowRight", "Space"],
    // The sounds the page has for as long as it lasts, by name, played once
    // it has been touched. The level's own are in its bundle. The theme is
    // short and goes round, so it is fetched whole and decoded; `?stream`
    // plays it as a long piece would be played, fetched as it goes.
    sounds: {
      start: "/start.wav",
      theme: new URLSearchParams(location.search).has("stream")
        ? Browser.stream("/theme.wav")
        : "/theme.wav",
    },
  }
);
