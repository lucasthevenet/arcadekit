/**
 * What the page's UI may see of the game, and what it may ask of it. The
 * UI imports this module and nothing else of the game: no component, no
 * system, no world.
 */
import { Schema } from "effect";

// In a game of your own these are "arcadekit/Action" and "arcadekit/View".
import * as Action from "../../src/Action";
import * as View from "../../src/View";

export type PhaseName = "title" | "playing" | "paused";

// --- what the UI may see ---------------------------------------------------------
// Each with the value it has before the game has said anything.

/** What the menu is drawn from. It changes when the game starts, pauses or ends. */
export const Menu = View.define<{ phase: PhaseName }>("page/Menu", {
  phase: "title",
});

/** What the heads-up display is drawn from. It changes when a star is caught. */
export const Hud = View.define<{
  caught: number;
  level: "Absent" | "Loading" | "Ready" | "Failed";
}>("page/Hud", { caught: 0, level: "Absent" });

// --- what the UI may ask for -------------------------------------------------------
// The same actions the keys are bound to: a button is one more way to send one.

export const Start = Action.define("page/Start", Schema.Struct({}));
export const Quit = Action.define("page/Quit", Schema.Struct({}));
export const TogglePause = Action.define("page/TogglePause", Schema.Struct({}));
