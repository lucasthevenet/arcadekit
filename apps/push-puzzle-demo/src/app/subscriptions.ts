import type { PushPuzzleEvent } from "@arcadekit/push-puzzle";
import { PushPuzzleEngine } from "@arcadekit/push-puzzle/browser";
import { engineEntry, keyPresses, shortcutPresses } from "arcadekit/foldkit";
import { engineOf } from "arcadekit/runtime/browser";
import { Schema, Stream } from "effect";
import { Subscription } from "foldkit";

import { Message } from "./message";
import { isLoaded } from "./model";
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
  /**
   * While the viewport exists, the engine renders into it and its events become Messages, once
   * the levels and sprite sheet have loaded (`isLoaded`): the engine is made from the sheet,
   * and an entry that reported a failed load wouldn't run again after a retry. A failed load is
   * shown like LoadContent's.
   */
  engine: engineEntry({
    engine: engineOf(PushPuzzleEngine),
    isViewportMounted: (model) =>
      model.isViewportMounted && isLoaded(model.phase),
    toMessage,
    onError: (error) => Message.FailedToLoadContent({ error: error.message }),
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
