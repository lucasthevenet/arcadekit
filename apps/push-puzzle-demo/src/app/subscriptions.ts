/**
 * The app's Subscriptions: Foldkit's contract. Each turns something outside the UI into Messages
 * as a Stream: the engine's events, and the app's own keys.
 */
import { EngineEntry, KeyPresses, ShortcutPresses } from "arcadekit/foldkit";
import { Schema, Stream } from "effect";
import { Subscription } from "foldkit";

import { PushPuzzle } from "#push-puzzle";
import { PushPuzzleEngine } from "#push-puzzle/browser";

import { Message } from "./message";
import { isLoaded } from "./model";
import type { Model } from "./model";

/** The app's Subscriptions: the engine's entry, and the keys that work outside a run's input. */
export const subscriptions = Subscription.make<
  Model,
  Message,
  PushPuzzleEngine
>()((entry) => ({
  /**
   * While the viewport exists, the engine renders into it and the run's events become Messages,
   * once the levels and sprite sheet have loaded (`isLoaded`): attaching loads the sheet, and an
   * entry that reported a failed load wouldn't run again after a retry. A sheet that can't be
   * loaded, a view that can't be made and a crash are shown like LoadContent's failure.
   */
  engine: EngineEntry.make({
    engine: PushPuzzleEngine,
    isViewportMounted: (model) =>
      model.isViewportMounted && isLoaded(model.phase),
    toMessage: PushPuzzle.match({
      Hud: (hud) => Message.GotHud({ hud }),
      LevelSolved: ({ moves }) => Message.GotLevelSolved({ moves }),
    }),
    onError: (error) => Message.FailedToLoadContent({ error: error.message }),
  }),

  /** M mutes and unmutes, on any screen, but not with a modifier held or in a text field. */
  muteKey: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        ShortcutPresses.make(["KeyM"], () => Message.PressedMuteKey()),
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
          ? KeyPresses.make(["KeyR", "Escape"], (code) =>
              code === "KeyR"
                ? Message.PressedRestart()
                : Message.PressedEscape()
            )
          : Stream.empty,
    }
  ),
}));
