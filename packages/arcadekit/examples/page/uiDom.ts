/**
 * The page's menu and heads-up display, built with the page's own DOM.
 *
 * It is handed the bridge and nothing else. It draws from the game's
 * views, each time one is published with a new value and not otherwise,
 * and acts by sending actions.
 */
import type * as View from "../../src/View.ts";
import { Hud, Menu, Quit, Start, TogglePause } from "./protocol.ts";
import type { Requests } from "./protocol.ts";

/** Puts the UI in `root`, and returns what takes it out again. */
export const mount = (
  root: Element,
  ui: View.Bridge<Requests>
): (() => void) => {
  const hud = document.createElement("p");
  hud.className = "hud";
  const menu = document.createElement("nav");
  const button = (send: () => void): HTMLButtonElement => {
    const made = document.createElement("button");
    made.type = "button";
    made.addEventListener("click", send);
    menu.append(made);
    return made;
  };
  const start = button(() => ui.send(Start, {}));
  start.textContent = "Start";
  const pause = button(() => ui.send(TogglePause, {}));
  const quit = button(() => ui.send(Quit, {}));
  quit.textContent = "Quit";

  const showMenu = ({ phase }: typeof Menu.initial): void => {
    start.hidden = phase !== "title";
    pause.hidden = phase === "title";
    pause.textContent = phase === "paused" ? "Resume" : "Pause";
    quit.hidden = phase === "title";
  };
  const showHud = ({ caught, level }: typeof Hud.initial): void => {
    hud.textContent = level === "Loading" ? "Loading" : `Caught ${caught}`;
  };
  // As the game has it now, and again each time it changes.
  const stops = [ui.subscribe(Menu, showMenu), ui.subscribe(Hud, showHud)];
  root.append(hud, menu);
  return () => {
    for (const stop of stops) {
      stop();
    }
    hud.remove();
    menu.remove();
  };
};
