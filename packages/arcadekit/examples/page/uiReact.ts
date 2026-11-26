/**
 * The page's menu and heads-up display again, built with a UI library:
 * React. It is the same UI as uiDom.ts, on the same bridge.
 *
 * What binds the bridge to React is `useView`, three lines: a view is an
 * external store, whose value is the same object until it changes.
 */
import { createElement as h, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type * as View from "../../src/View.ts";
import { Hud, Menu, Quit, Start, TogglePause } from "./protocol.ts";
import type { Requests } from "./protocol.ts";

/** A view's value, in a component that is drawn again when it changes. */
const useView = <A>(ui: View.Bridge, view: View.View<A>): A =>
  useSyncExternalStore(
    (changed) => ui.subscribe(view, changed),
    () => ui.get(view)
  );

const HudLine = ({ ui }: { readonly ui: View.Bridge }): ReactNode => {
  const { caught, level } = useView(ui, Hud);
  return h(
    "p",
    { className: "hud" },
    level === "Loading" ? "Loading" : `Caught ${caught}`
  );
};

const MenuBar = ({ ui }: { readonly ui: View.Bridge<Requests> }): ReactNode => {
  const { phase } = useView(ui, Menu);
  return h(
    "nav",
    null,
    phase === "title"
      ? h("button", { type: "button", onClick: () => ui.send(Start) }, "Start")
      : [
          h(
            "button",
            {
              key: "pause",
              type: "button",
              onClick: () => ui.send(TogglePause),
            },
            phase === "paused" ? "Resume" : "Pause"
          ),
          h(
            "button",
            { key: "quit", type: "button", onClick: () => ui.send(Quit) },
            "Quit"
          ),
        ]
  );
};

/** Puts the UI in `root`, and returns what takes it out again. */
export const mount = (
  root: Element,
  ui: View.Bridge<Requests>
): (() => void) => {
  const react = createRoot(root);
  // Two components, so that a star caught draws the line and not the menu.
  react.render([
    h(HudLine, { key: "hud", ui }),
    h(MenuBar, { key: "menu", ui }),
  ]);
  return () => react.unmount();
};
