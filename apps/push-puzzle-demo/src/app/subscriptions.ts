import { engineEntry, keyPresses, shortcutPresses } from "@gamekit/foldkit";
import type { PushPuzzleEvent } from "@gamekit/push-puzzle";
import { PushPuzzleEngine } from "@gamekit/push-puzzle/browser";
import { Schema, Stream } from "effect";
import { Subscription } from "foldkit";

import { Message } from "./message";
import type { Model } from "./model";

const toMessage = (event: PushPuzzleEvent): Message => {
  switch (event.type) {
    case "hud": {
      return Message.GotHud({ hud: event.hud });
    }
    case "levelSolved": {
      return Message.GotLevelSolved({ moves: event.moves });
    }
  }
};

export const subscriptions = Subscription.make<
  Model,
  Message,
  PushPuzzleEngine
>()((entry) => ({
  /** While the viewport exists, the engine renders into it and its events become Messages. */
  engine: engineEntry({
    engine: PushPuzzleEngine,
    isViewportMounted: (model) => model.isViewportMounted,
    toMessage,
  }),

  /** M mutes and unmutes, on any screen, but not with a modifier held or in a text field. */
  muteKey: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        shortcutPresses(["KeyM"], () => Message.PressedMuteKey()),
    }
  ),

  /** R restarts and Escape goes back to level select, but only during a run. Not simulation input. */
  runKeys: entry(
    { inRun: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        inRun: model.phase._tag === "Playing" || model.phase._tag === "Solved",
      }),
      dependenciesToStream: ({ inRun }) =>
        inRun
          ? keyPresses(["KeyR", "Escape"], (code) =>
              code === "KeyR"
                ? Message.PressedRestart()
                : Message.PressedEscape()
            )
          : Stream.empty,
    }
  ),
}));
