import { engineEntry, keyPresses } from "@gamekit/foldkit";
import type { SurvivorsEvent } from "@gamekit/survivors";
import { SurvivorsEngine } from "@gamekit/survivors/browser";
import { Schema, Stream } from "effect";
import { Subscription } from "foldkit";

import { Message } from "./message";
import type { Model } from "./model";

const toMessage = (event: SurvivorsEvent): Message => {
  switch (event.type) {
    case "hud": {
      return Message.GotHud({ hud: event.hud });
    }
    case "levelUp": {
      return Message.GotLevelUp({
        choices: event.choices.map((choice) => ({ ...choice })),
      });
    }
    case "runEnded": {
      return Message.GotRunEnded({ summary: event.summary });
    }
  }
};

export const subscriptions = Subscription.make<
  Model,
  Message,
  SurvivorsEngine
>()((entry) => ({
  /** While the viewport exists, the engine renders into it and its events become Messages. */
  engine: engineEntry({
    engine: SurvivorsEngine,
    isViewportMounted: (model) => model.isViewportMounted,
    toMessage,
  }),

  /** Escape (or P) toggles pause, but only during a run. */
  pauseKey: entry(
    { canPause: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        canPause:
          model.phase._tag === "Playing" || model.phase._tag === "Paused",
      }),
      dependenciesToStream: ({ canPause }) =>
        canPause
          ? keyPresses(["Escape", "KeyP"], () => Message.PressedEscape())
          : Stream.empty,
    }
  ),
}));
