import { engineEntry, keyPresses } from "@gamekit/foldkit";
import type { SurvivorsEvent } from "@gamekit/survivors";
import { SurvivorsEngine } from "@gamekit/survivors/browser";
import { Schema, Stream } from "effect";
import { Subscription } from "foldkit";

import type { CoopEvent } from "../coop/client";
import { Coop } from "./coop";
import { Message } from "./message";
import { isCoop } from "./model";
import type { Model } from "./model";

/** A single-player run's one hero is slot 0. */
const LOCAL_HERO = 0;

const toMessage = (event: SurvivorsEvent): Message | undefined => {
  switch (event.type) {
    case "hud": {
      return Message.GotHud({ hud: event.hud });
    }
    case "levelUp": {
      return event.hero === LOCAL_HERO
        ? Message.GotLevelUp({ choices: event.choices })
        : undefined;
    }
    case "heroLeft": {
      return undefined;
    }
    case "runEnded": {
      return Message.GotRunEnded({ summary: event.summaries[LOCAL_HERO]! });
    }
  }
};

const coopMessage = (event: CoopEvent): Message => {
  switch (event.type) {
    case "lobby": {
      return Message.GotCoopLobby({
        role: event.role,
        code: event.code,
        self: event.self,
        players: event.players.map(({ id, heroId }) => ({ id, heroId })),
      });
    }
    case "started": {
      return Message.GotCoopStarted({
        slot: event.slot,
        players: [...event.players],
      });
    }
    case "waiting": {
      return Message.GotCoopWaiting({
        waitingFor: [...event.waitingFor],
        choosing: [...event.choosing],
      });
    }
    case "failed": {
      return Message.GotCoopFailed({ error: event.message });
    }
    case "hud": {
      return Message.GotHud({ hud: event.hud });
    }
    case "levelUp": {
      return Message.GotCoopLevelUp({
        offer: event.offer,
        choices: event.choices,
      });
    }
    case "runEnded": {
      return Message.GotCoopRunEnded({ summary: event.summary });
    }
  }
};

export const subscriptions = Subscription.make<
  Model,
  Message,
  SurvivorsEngine | Coop
>()((entry) => ({
  /**
   * While the viewport exists, the engine renders into it and its events become Messages.
   * Co-op's screens hand the viewport to the co-op client instead.
   */
  engine: engineEntry({
    engine: SurvivorsEngine,
    isViewportMounted: (model) =>
      model.isViewportMounted && !isCoop(model.phase),
    toMessage,
  }),

  /** On co-op's screens, the co-op client draws its run and reports its lobby and run. */
  coop: engineEntry({
    engine: Coop,
    isViewportMounted: (model) =>
      model.isViewportMounted && isCoop(model.phase),
    toMessage: coopMessage,
  }),

  /** Escape (or P) toggles pause, but only during a run. */
  pauseKey: entry(
    { canPause: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        canPause:
          model.phase._tag === "Playing" ||
          model.phase._tag === "Paused" ||
          model.phase._tag === "CoopPlaying",
      }),
      dependenciesToStream: ({ canPause }) =>
        canPause
          ? keyPresses(["Escape", "KeyP"], () => Message.PressedEscape())
          : Stream.empty,
    }
  ),
}));
