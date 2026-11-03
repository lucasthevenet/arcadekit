import { engineMessages, keyPresses } from "@gamekit/foldkit";
import type { PushPuzzleEvent } from "@gamekit/push-puzzle";
import { PushPuzzleEngine } from "@gamekit/push-puzzle/browser";
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
  engine: entry(
    { isViewportMounted: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        isViewportMounted: model.isViewportMounted,
      }),
      dependenciesToStream: ({ isViewportMounted }) =>
        isViewportMounted
          ? engineMessages({
              engine: Effect.service(PushPuzzleEngine),
              elementId: VIEWPORT_ID,
              toMessage,
            })
          : Stream.empty,
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
