/**
 * What the page's UI may see of the game, and what it may ask of it. The
 * UI imports this module and nothing else of the game: no component, no
 * system, no world.
 */
// In a game of your own these are "arcadekit/Action" and "arcadekit/View".
import * as Action from "../../src/Action.ts";
import * as View from "../../src/View.ts";

export type PhaseName = "title" | "playing" | "paused";

// --- what the UI may see ---------------------------------------------------------
// Each with the value it has before the game has said anything.

/** What the menu is drawn from. It changes when the game starts, pauses or ends. */
export const Menu = View.define("page/Menu", { phase: "title" as PhaseName });

/** What the heads-up display is drawn from. It changes when a star is caught. */
export const Hud = View.define("page/Hud", {
  caught: 0,
  level: "Absent" as "Absent" | "Loading" | "Ready" | "Failed",
});

// --- what the UI may ask for -------------------------------------------------------
// The same actions the keys are bound to: a button is one more way to send one.

export const Start = Action.define("page/Start");
export const Quit = Action.define("page/Quit");
export const TogglePause = Action.define("page/TogglePause");

/**
 * Every action the UI may ask for. The UI takes a `View.Bridge<Requests>`,
 * and the compiler hands it only the bridge of a game that handles each one.
 */
export type Requests = typeof Start | typeof Quit | typeof TogglePause;
