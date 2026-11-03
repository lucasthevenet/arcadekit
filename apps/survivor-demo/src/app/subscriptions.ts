import { engineMessages, keyPresses } from "@gamekit/foldkit";
import type { SurvivorsEvent } from "@gamekit/survivors";
import { SurvivorsEngine } from "@gamekit/survivors/browser";
import { Effect, Schema, Stream } from "effect";
import { Mount, Subscription } from "foldkit";

import { Message } from "./message";
import type { Model } from "./model";

export const VIEWPORT_ID = "game-viewport";

/** Reports that the game's DOM element now exists. The engine subscription below waits for this. */
export const GameViewport = Mount.define("GameViewport", {
  messages: [Message.MountedViewport],
  execute: () => Effect.succeed(Message.MountedViewport()),
});

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
  engine: entry(
    { isViewportMounted: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        isViewportMounted: model.isViewportMounted,
      }),
      dependenciesToStream: ({ isViewportMounted }) =>
        isViewportMounted
          ? engineMessages({
              engine: Effect.service(SurvivorsEngine),
              elementId: VIEWPORT_ID,
              toMessage,
            })
          : Stream.empty,
    }
  ),

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
