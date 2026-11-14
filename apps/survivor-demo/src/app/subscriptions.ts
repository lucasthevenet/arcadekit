/**
 * The app's Subscriptions: Foldkit's contract. Each turns something outside the UI into Messages
 * as a Stream (the engine's events, the Co-op client's, the app's own keys), or keeps something
 * outside it in step with the Model (the audio system).
 */
import { Survivors } from "@arcadekit/survivors";
import { SurvivorsCoop, SurvivorsEngine } from "@arcadekit/survivors/browser";
import { AudioSystem } from "arcadekit/audio";
import { EngineEntry, KeyPresses, ShortcutPresses } from "arcadekit/foldkit";
import { Effect, Schema, Stream } from "effect";
import { Subscription } from "foldkit";

import { Message } from "./message";
import { isCoop, isLoaded } from "./model";
import type { Model, Phase } from "./model";
import * as Sounds from "./sounds";

/** A single-player run's one hero is slot 0. */
const LOCAL_HERO = 0;

/**
 * Everything a co-op seat reports, as Messages: the Co-op client's own events, and under `run`
 * the genre's, as the single-player engine reports them, with the local player in the engine's
 * `LOCAL_HERO`'s place. The lobby goes into its Message as it is; a player's offer and summary
 * are its own hero's, and another hero's offer, or a hero leaving, is no Message (`undefined`).
 */
export const coopMessage = SurvivorsCoop.match({
  LobbyChanged: (lobby) => Message.GotCoopLobby({ lobby }),
  RunStarted: ({ slot, names }) => Message.GotCoopStarted({ slot, names }),
  WaitingChanged: ({ waitingFor }) => Message.GotCoopWaiting({ waitingFor }),
  // The kit's text, as it is. `reason` is there for an app that words its own.
  SeatFailed: ({ message }) => Message.GotCoopFailed({ error: message }),
  run: {
    Hud: (hud) => Message.GotHud({ hud }),
    LeveledUp: ({ hero, offer, choices }, { local }) =>
      hero === local.slot
        ? Message.GotCoopLevelUp({ offer, choices })
        : undefined,
    HeroLeft: () => undefined,
    RunEnded: ({ summaries }, { local }) => {
      const summary = summaries[local.slot];
      return summary === undefined
        ? undefined
        : Message.GotCoopRunEnded({ summary });
    },
  },
});

/** The run's music from the start of a run to its end; the menu's everywhere else. */
const musicFor = (phase: Phase): keyof typeof Sounds.music => {
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

/** What the `sound` Subscription follows: the music and the ducking for the screen, and the player's settings. */
const SoundDependencies = {
  music: Schema.Literals(["menu", "run"]),
  ducked: Schema.Boolean,
  master: Schema.Number,
  sfx: Schema.Number,
  musicVolume: Schema.Number,
  muted: Schema.Boolean,
};

/**
 * The app's Subscriptions: the engine's entry and the Co-op client's, the keys that work outside
 * a run's input, and the audio system kept in step with the Model.
 */
export const subscriptions = Subscription.make<
  Model,
  Message,
  SurvivorsEngine | SurvivorsCoop | AudioSystem.AudioSystem
>()((entry) => ({
  /**
   * While the viewport exists, the engine renders into it and the run's events become Messages,
   * once the content and sprite sheet have loaded (`isLoaded`): attaching loads the sheet, and an
   * entry that reported a failed load wouldn't run again after a retry. A sheet that can't be
   * loaded, a view that can't be made and a crash are shown like LoadContent's failure. Co-op's
   * screens hand the viewport to the co-op client instead.
   */
  engine: EngineEntry.make({
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
  coop: EngineEntry.make({
    engine: SurvivorsCoop,
    isViewportMounted: (model) =>
      model.isViewportMounted && isCoop(model.phase),
    toMessage: coopMessage,
    onError: (error) => Message.GotCoopFailed({ error: error.message }),
  }),

  /**
   * Escape (or P) toggles pause, but only while a run plays or is paused, not over an offer. In
   * co-op it opens and closes the run's menu, which asks for the co-op pause while it is up,
   * unless the local hero is down. Not simulation input.
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
          ? KeyPresses.make(["Escape", "KeyP"], () => Message.PressedEscape())
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
          const audio = yield* AudioSystem.AudioSystem;
          AudioSystem.applySettings(audio, { ...settings, music: musicVolume });
          audio.playMusic(Sounds.music[music]);
          audio.setDucked(ducked);
        })
      ).pipe(Stream.drain),
  }),

  /** M toggles mute on any screen, but not with Ctrl, Cmd or Alt held, or while typing (the join code). */
  muteKey: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        ShortcutPresses.make(["KeyM"], () => Message.PressedMute()),
    }
  ),
}));
