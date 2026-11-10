import type { SurvivorsContent } from "@arcadekit/survivors";
import type { SurvivorsEngine } from "@arcadekit/survivors/browser";
import { defaultAudioSettings } from "arcadekit/audio";
import type { Audio, AudioSettings } from "arcadekit/audio";
import type { Runtime, Update } from "foldkit";

import {
  ChooseCoopHero,
  ChooseCoopUpgrade,
  ChooseUpgrade,
  EndRun,
  FocusRetry,
  HostCoop,
  JoinCoop,
  LeaveCoop,
  LoadAudioSettings,
  LoadContent,
  LoadSave,
  LoadSounds,
  PlayClick,
  SaveAudioSettings,
  SaveRun,
  SetCoopPaused,
  SetPaused,
  StartCoop,
  StartRun,
} from "./commands";
import type { Coop } from "./coop";
import { Message } from "./message";
import { Phase, emptyCoopRun, emptyHud, isCoop } from "./model";
import type { Model } from "./model";
import { emptyRecords, mergeRecords, withRun } from "./save";
import type { Save } from "./save";
import type { SoundSettings } from "./sound";

export type Services =
  | SurvivorsContent
  | SurvivorsEngine
  | Save
  | Coop
  | Audio
  | SoundSettings;
type Return = Update.Return<Model, Message, Services>;

export const init: Runtime.ApplicationInit<
  Model,
  Message,
  void,
  Services
> = () => ({
  model: {
    phase: Phase.Loading(),
    heroes: [],
    selectedHeroId: "",
    records: emptyRecords,
    hud: emptyHud,
    isViewportMounted: false,
    coop: emptyCoopRun,
    audio: defaultAudioSettings,
  },
  commands: [LoadContent(), LoadSave(), LoadAudioSettings(), LoadSounds()],
});

/** The messages of the menu buttons and upgrade picks: each plays a click. */
const CLICKS: ReadonlySet<Message["_tag"]> = new Set([
  "ClickedRetry",
  "SelectedHero",
  "ClickedStart",
  "ClickedUpgrade",
  "ClickedResume",
  "ClickedQuit",
  "ClickedPlayAgain",
  "ClickedCoop",
  "ClickedHostCoop",
  "ClickedJoinCoop",
  "ClickedStartCoop",
  "ClickedCoopUpgrade",
  "ClickedCoopResume",
  "ClickedLeaveCoop",
  "ClickedMute",
]);

/** Changes the audio settings: the sound subscription applies them, and they are saved. */
const changeAudio = (model: Model, audio: AudioSettings): Return => ({
  model: { ...model, audio },
  commands: [SaveAudioSettings({ settings: audio })],
});

/** The load-error screen, with its "Try again" focused. */
const loadFailed = (model: Model, error: string): Return => ({
  model: { ...model, phase: Phase.LoadFailed({ error }) },
  commands: [FocusRetry()],
});

const startRun = (model: Model): Return => ({
  model: { ...model, phase: Phase.Starting() },
  commands: [StartRun({ heroId: model.selectedHeroId })],
});

const leaveCoop = (model: Model): Return => ({
  model: { ...model, phase: Phase.Menu(), hud: emptyHud, coop: emptyCoopRun },
  commands: [LeaveCoop()],
});

/** Toggles the local player's pause flag in a co-op run: its hero holds the run for everyone. */
const toggleCoopPause = (model: Model, paused: boolean): Return => ({
  model: { ...model, coop: { ...model.coop, paused } },
  commands: [SetCoopPaused({ paused })],
});

const backToMenu = (model: Model): Return => ({
  model: { ...model, phase: Phase.Menu() },
  commands: [EndRun()],
});

export const update = (model: Model, message: Message): Return => {
  const result = handle(model, message);
  return CLICKS.has(message._tag)
    ? { ...result, commands: [...(result.commands ?? []), PlayClick()] }
    : result;
};

const handle = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    LoadedContent: ({ heroes }) => ({
      model: {
        ...model,
        heroes,
        selectedHeroId: heroes[0]?.id ?? "",
        phase: Phase.Menu(),
      },
    }),
    FailedToLoadContent: ({ error }) => loadFailed(model, error),
    // Loads again, then goes to the menu as on a first load. Each loader keeps its first
    // success, so only what failed is fetched again.
    ClickedRetry: () =>
      model.phase._tag === "LoadFailed"
        ? {
            model: { ...model, phase: Phase.Loading() },
            commands: [LoadContent()],
          }
        : { model },
    LoadedSave: ({ records }) => ({
      model: { ...model, records: mergeRecords(model.records, records) },
    }),
    MountedViewport: () => ({ model: { ...model, isViewportMounted: true } }),
    UnmountedViewport: () => ({
      model: { ...model, isViewportMounted: false },
    }),

    SelectedHero: ({ heroId }) =>
      model.phase._tag === "CoopLobby"
        ? {
            model: { ...model, selectedHeroId: heroId },
            commands: [ChooseCoopHero({ heroId })],
          }
        : { model: { ...model, selectedHeroId: heroId } },
    ClickedStart: () =>
      model.phase._tag === "Menu" ? startRun(model) : { model },
    StartedRun: () => ({ model: { ...model, phase: Phase.Playing() } }),
    FailedToStartRun: ({ error }) => loadFailed(model, error),

    GotHud: ({ hud }) => ({ model: { ...model, hud } }),
    GotLevelUp: ({ choices }) => ({
      model: { ...model, phase: Phase.LevelUp({ choices }) },
    }),
    GotRunEnded: ({ summary }) => ({
      model: {
        ...model,
        phase: Phase.GameOver({ summary }),
        records: withRun(model.records, summary),
      },
      commands: [SaveRun({ summary })],
    }),
    SavedRun: ({ records }) => ({
      model: { ...model, records: mergeRecords(model.records, records) },
    }),

    ClickedUpgrade: ({ index }) =>
      model.phase._tag === "LevelUp"
        ? {
            model: { ...model, phase: Phase.Playing() },
            commands: [ChooseUpgrade({ index })],
          }
        : { model },
    PressedEscape: () => {
      if (model.phase._tag === "CoopPlaying") {
        return toggleCoopPause(model, !model.coop.paused);
      }
      if (model.phase._tag === "Playing") {
        return {
          model: { ...model, phase: Phase.Paused() },
          commands: [SetPaused({ paused: true })],
        };
      }
      if (model.phase._tag === "Paused") {
        return {
          model: { ...model, phase: Phase.Playing() },
          commands: [SetPaused({ paused: false })],
        };
      }
      return { model };
    },
    ClickedResume: () => ({
      model: { ...model, phase: Phase.Playing() },
      commands: [SetPaused({ paused: false })],
    }),
    ClickedQuit: () => backToMenu(model),
    ClickedPlayAgain: () => startRun(model),

    ClickedCoop: () =>
      model.phase._tag === "Menu"
        ? {
            model: {
              ...model,
              phase: Phase.CoopMenu({ joinCode: "" }),
              coop: emptyCoopRun,
            },
          }
        : { model },
    ClickedHostCoop: () =>
      model.phase._tag === "CoopMenu"
        ? {
            model: { ...model, phase: Phase.CoopConnecting() },
            commands: [HostCoop({ heroId: model.selectedHeroId })],
          }
        : { model },
    ChangedJoinCode: ({ code }) =>
      model.phase._tag === "CoopMenu"
        ? {
            model: {
              ...model,
              phase: Phase.CoopMenu({ joinCode: code.toUpperCase() }),
            },
          }
        : { model },
    ClickedJoinCoop: () =>
      model.phase._tag === "CoopMenu"
        ? {
            model: { ...model, phase: Phase.CoopConnecting() },
            commands: [
              JoinCoop({
                code: model.phase.joinCode,
                heroId: model.selectedHeroId,
              }),
            ],
          }
        : { model },
    ClickedStartCoop: () =>
      model.phase._tag === "CoopLobby" && model.phase.role === "host"
        ? { model, commands: [StartCoop()] }
        : { model },
    ClickedCoopUpgrade: ({ index }) =>
      model.phase._tag === "CoopLevelUp"
        ? {
            model: { ...model, phase: Phase.CoopPlaying() },
            commands: [ChooseCoopUpgrade({ offer: model.phase.offer, index })],
          }
        : { model },
    ClickedCoopResume: () =>
      model.phase._tag === "CoopPlaying"
        ? toggleCoopPause(model, false)
        : { model },
    ClickedLeaveCoop: () =>
      isCoop(model.phase) ? leaveCoop(model) : { model },
    GotCoopLobby: ({ role, code, self, players }) =>
      model.phase._tag === "CoopConnecting" || model.phase._tag === "CoopLobby"
        ? {
            model: {
              ...model,
              phase: Phase.CoopLobby({ role, code, self, players }),
            },
          }
        : { model },
    // Co-op events can be queued behind a Leave: each counts only in the phase it belongs to.
    GotCoopStarted: ({ slot, players }) =>
      model.phase._tag === "CoopLobby"
        ? {
            model: {
              ...model,
              phase: Phase.CoopPlaying(),
              hud: emptyHud,
              coop: { ...emptyCoopRun, slot, players },
            },
          }
        : { model },
    GotCoopWaiting: ({ waitingFor, choosing }) =>
      model.phase._tag === "CoopPlaying" || model.phase._tag === "CoopLevelUp"
        ? {
            model: { ...model, coop: { ...model.coop, waitingFor, choosing } },
          }
        : { model },
    GotCoopLevelUp: ({ offer, choices }) =>
      model.phase._tag === "CoopPlaying"
        ? { model: { ...model, phase: Phase.CoopLevelUp({ offer, choices }) } }
        : { model },
    GotCoopRunEnded: ({ summary }) =>
      model.phase._tag === "CoopPlaying" || model.phase._tag === "CoopLevelUp"
        ? { model: { ...model, phase: Phase.CoopGameOver({ summary }) } }
        : { model },
    GotCoopFailed: ({ error }) =>
      isCoop(model.phase)
        ? { model: { ...model, phase: Phase.CoopFailed({ error }) } }
        : { model },

    LoadedAudioSettings: ({ settings }) => ({
      model: { ...model, audio: settings },
    }),
    ChangedVolume: ({ bus, volume }) =>
      changeAudio(model, {
        ...model.audio,
        [bus]: Math.max(0, Math.min(1, volume)),
      }),
    ClickedMute: () =>
      changeAudio(model, { ...model.audio, muted: !model.audio.muted }),
    PressedMute: () =>
      changeAudio(model, { ...model.audio, muted: !model.audio.muted }),

    CompletedEngineCommand: () => ({ model }),
    CompletedAudioCommand: () => ({ model }),
    CompletedFocusCommand: () => ({ model }),
  });
