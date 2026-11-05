import { Audio, applyAudioSettings } from "@gamekit/audio";
import { engineEntry, keyPresses, shortcutPresses } from "@gamekit/foldkit";
import { engineOf } from "@gamekit/runtime/browser";
import type { SurvivorsEvent } from "@gamekit/survivors";
import { SurvivorsEngine } from "@gamekit/survivors/browser";
import { Effect, Schema, Stream } from "effect";
import { Subscription } from "foldkit";

import type { CoopEvent } from "../coop/client";
import { Coop } from "./coop";
import { Message } from "./message";
import { isCoop, isLoaded } from "./model";
import type { Model, Phase } from "./model";
import { MUSIC } from "./sound";

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

/** The run's music from the start of a run to its end; the menu's everywhere else. */
const musicFor = (phase: Phase): keyof typeof MUSIC => {
  switch (phase._tag) {
    case "Starting":
    case "Playing":
    case "Paused":
    case "LevelUp":
    case "CoopPlaying":
    case "CoopLevelUp": {
      return "run";
    }
    default: {
      return "menu";
    }
  }
};

/** Whether the run is paused: by this player, or in co-op by anyone. */
const isPaused = (model: Model): boolean =>
  model.phase._tag === "Paused" ||
  (model.phase._tag === "CoopPlaying" &&
    (model.coop.paused || model.hud.heroes.some((hero) => hero.paused)));

const SoundDependencies = {
  music: Schema.Literals(["menu", "run"]),
  ducked: Schema.Boolean,
  master: Schema.Number,
  sfx: Schema.Number,
  musicVolume: Schema.Number,
  muted: Schema.Boolean,
};

export const subscriptions = Subscription.make<
  Model,
  Message,
  SurvivorsEngine | Coop | Audio
>()((entry) => ({
  /**
   * While the viewport exists, the engine renders into it and its events become Messages, once
   * the content and sprite sheet have loaded (`isLoaded`): the engine is made from the sheet,
   * and an entry that reported a failed load wouldn't run again after a retry. A failed load is
   * shown like LoadContent's. Co-op's screens hand the viewport to the co-op client instead.
   */
  engine: engineEntry({
    engine: engineOf(SurvivorsEngine),
    isViewportMounted: (model) =>
      model.isViewportMounted && isLoaded(model.phase) && !isCoop(model.phase),
    toMessage,
    onError: (error) => Message.FailedToLoadContent({ error: error.message }),
  }),

  /**
   * On co-op's screens, the co-op client draws its run and reports its lobby and run. Co-op's
   * screens are reached from the menu, after the sheet has loaded; a failed load ends co-op.
   */
  coop: engineEntry({
    engine: Coop,
    isViewportMounted: (model) =>
      model.isViewportMounted && isCoop(model.phase),
    toMessage: coopMessage,
    onError: (error) => Message.GotCoopFailed({ error: error.message }),
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

  /**
   * Keeps the audio system in step with the Model: the music for the screen, ducked while
   * paused, and the player's volumes and mute. Emits nothing.
   */
  sound: entry(SoundDependencies, {
    modelToDependencies: (model) => ({
      music: musicFor(model.phase),
      ducked: isPaused(model),
      master: model.audio.master,
      sfx: model.audio.sfx,
      musicVolume: model.audio.music,
      muted: model.audio.muted,
    }),
    dependenciesToStream: ({ music, ducked, musicVolume, ...settings }) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          const audio = yield* Audio;
          applyAudioSettings(audio, { ...settings, music: musicVolume });
          audio.playMusic(MUSIC[music]);
          audio.setDucked(ducked);
        })
      ).pipe(Stream.drain),
  }),

  /** M toggles mute on any screen, except while typing (the join code). */
  muteKey: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        shortcutPresses(["KeyM"], () => Message.PressedMute()),
    }
  ),
}));
