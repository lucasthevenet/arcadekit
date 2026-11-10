import { Survivors } from "@arcadekit/survivors";
import type { SurvivorsCoopEvent } from "@arcadekit/survivors";
import { SurvivorsEngine } from "@arcadekit/survivors/browser";
import { Audio, applyAudioSettings } from "arcadekit/audio";
import { engineEntry, keyPresses, shortcutPresses } from "arcadekit/foldkit";
import type { CoopEvent } from "arcadekit/net/browser";
import { Effect, Schema, Stream } from "effect";
import { Subscription } from "foldkit";

import { Coop } from "./coop";
import { Message } from "./message";
import { isCoop, isLoaded } from "./model";
import type { Model, Phase } from "./model";
import { MUSIC } from "./sound";

/** A single-player run's one hero is slot 0. */
const LOCAL_HERO = 0;

/** What the co-op run tells the local player: the genre's own events for its hero. */
const coopRunMessage = (event: SurvivorsCoopEvent): Message => {
  switch (event.type) {
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

export const coopMessage = (event: CoopEvent<SurvivorsCoopEvent>): Message => {
  switch (event.type) {
    case "lobby": {
      return Message.GotCoopLobby({
        role: event.role,
        code: event.code,
        self: event.self,
        players: event.players.map(({ id, name, pick }) => ({
          id,
          name,
          pick,
        })),
        maxPlayers: event.maxPlayers,
        canStart: event.canStart,
      });
    }
    case "started": {
      return Message.GotCoopStarted({
        slot: event.slot,
        names: [...event.names],
      });
    }
    case "waiting": {
      return Message.GotCoopWaiting({
        waitingFor: [...event.waitingFor],
        choosing: [...event.choosing],
      });
    }
    case "failed": {
      // The kit's text, as it is. `event.reason` is there for an app that words its own.
      return Message.GotCoopFailed({ error: event.message });
    }
    case "run": {
      return coopRunMessage(event.event);
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
   * While the viewport exists, the engine renders into it and the run's events become Messages,
   * once the content and sprite sheet have loaded (`isLoaded`): attaching loads the sheet, and an
   * entry that reported a failed load wouldn't run again after a retry. A sheet that can't be
   * loaded, a view that can't be made and a crash are shown like LoadContent's failure. Co-op's
   * screens hand the viewport to the co-op client instead.
   */
  engine: engineEntry({
    engine: SurvivorsEngine,
    isViewportMounted: (model) =>
      model.isViewportMounted && isLoaded(model.phase) && !isCoop(model.phase),
    toMessage: Survivors.match({
      Hud: (hud) => Message.GotHud({ hud }),
      LeveledUp: ({ hero, offer, choices }) =>
        hero === LOCAL_HERO
          ? Message.GotLevelUp({ offer, choices })
          : undefined,
      HeroLeft: () => undefined,
      RunEnded: ({ summaries }) =>
        Message.GotRunEnded({ summary: summaries[LOCAL_HERO]! }),
    }),
    onError: (error) => Message.FailedToLoadContent({ error: error.message }),
  }),

  /**
   * On co-op's screens, the Co-op client draws its run and reports its lobby and run. Co-op's
   * screens are reached from the menu, after the sheet has loaded. An attach that fails (the
   * sheet, no WebGL, a frame that throws) ends co-op: the client has left by then.
   */
  coop: engineEntry({
    engine: Coop,
    isViewportMounted: (model) =>
      model.isViewportMounted && isCoop(model.phase),
    toMessage: coopMessage,
    onError: (error) => Message.GotCoopFailed({ error: error.message }),
  }),

  /**
   * Escape (or P) toggles pause, but only during a run. In co-op it opens and closes the run's
   * menu, which holds the co-op pause while it is up.
   */
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
