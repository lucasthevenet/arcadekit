/**
 * The app's `init` and `update`: Foldkit's contract.
 *
 * Plain on purpose: `update` is a pure function, whose side effects are the Commands it returns
 * (Foldkit's contract).
 */
import { AudioSettings } from "arcadekit/audio";
import type { AudioSystem } from "arcadekit/audio";
import type { Runtime, Update } from "foldkit";

import type { SurvivorsContent } from "#survivors";
import type {
  SurvivorsCoop,
  SurvivorsEngine,
  SurvivorsSheet,
} from "#survivors/browser";

import type { SurvivorsAudioSettings } from "./audio-settings";
import {
  ChooseCoopHero,
  EndRun,
  FocusRetry,
  HostCoop,
  JoinCoop,
  LeaveCoop,
  LoadAudioSettings,
  LoadContent,
  LoadSave,
  LoadSounds,
  PickCoopUpgrade,
  PickUpgrade,
  PlayClick,
  SaveAudioSettings,
  SaveRun,
  SetCoopPaused,
  SetPaused,
  StartCoop,
  StartRun,
} from "./commands";
import * as HeroRecords from "./hero-records";
import { Message } from "./message";
import {
  Phase,
  emptyCoopRun,
  emptyHud,
  isCoop,
  isLocalHeroDown,
} from "./model";
import type { Model } from "./model";
import { SurvivorsSave } from "./save";

/** The app's services, which its Commands run against: what `resources` provides. */
export type Services =
  | SurvivorsContent
  | SurvivorsEngine
  | SurvivorsSheet
  | SurvivorsSave
  | SurvivorsCoop
  | AudioSystem.AudioSystem
  | SurvivorsAudioSettings;
type Return = Update.Return<Model, Message, Services>;

/** The app at startup: loading, with the Commands that load the content, the save, the settings and the sounds. */
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
    records: HeroRecords.empty,
    hud: emptyHud,
    isViewportMounted: false,
    coop: emptyCoopRun,
    audio: AudioSettings.defaults,
  },
  commands: [LoadContent(), LoadSave(), LoadAudioSettings(), LoadSounds()],
});

/** The Messages of the buttons (menus, heroes, upgrade picks, mute): each plays a click. */
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

/** Changes the audio settings: the `sound` Subscription applies them, and they are saved. */
const changeAudio = (
  model: Model,
  audio: AudioSettings.AudioSettings
): Return => ({
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

/**
 * Opens the co-op run's menu, or closes it. While it is up the local player holds the run
 * paused for everyone: opening it asks the run for the pause and closing it lets go. The app's
 * own pause flag changes at once, so the screen answers the key; the run takes the command a
 * few steps later, or refuses it. The menu doesn't wait on that answer, nor close on it: it is
 * the only way to leave the run. A hero that is down holds no pause, so its player's menu opens
 * over a run that plays on, and asks for nothing.
 */
const setCoopMenu = (model: Model, open: boolean): Return => {
  const paused = open && !isLocalHeroDown(model);
  return {
    model: { ...model, coop: { ...model.coop, menu: open, paused } },
    // Nothing to send when the pause stays as it is: none was asked for, or the run took none.
    commands: paused === model.coop.paused ? [] : [SetCoopPaused({ paused })],
  };
};

const backToMenu = (model: Model): Return => ({
  model: { ...model, phase: Phase.Menu() },
  commands: [EndRun()],
});

/**
 * The next Model, and the Commands to run, for each Message. A button's Message (`CLICKS`) also
 * plays the click (`PlayClick`), after the Commands it runs.
 */
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
    // Loads again, then goes to the menu as on a first load. The content and the sheet each
    // keep their first success, so only what failed is fetched again.
    ClickedRetry: () =>
      model.phase._tag === "LoadFailed"
        ? {
            model: { ...model, phase: Phase.Loading() },
            commands: [LoadContent()],
          }
        : { model },
    LoadedSave: ({ records }) => ({
      model: { ...model, records: SurvivorsSave.merge(model.records, records) },
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
    GotLevelUp: ({ offer, choices }) => ({
      model: { ...model, phase: Phase.LevelUp({ offer, choices }) },
    }),
    GotRunEnded: ({ summary }) => ({
      model: {
        ...model,
        phase: Phase.GameOver({ summary }),
        records: SurvivorsSave.merge(
          model.records,
          HeroRecords.fromSummary(summary)
        ),
      },
      commands: [SaveRun({ summary })],
    }),
    SavedRun: ({ records }) => ({
      model: { ...model, records: SurvivorsSave.merge(model.records, records) },
    }),

    ClickedUpgrade: ({ index }) =>
      model.phase._tag === "LevelUp"
        ? {
            model: { ...model, phase: Phase.Playing() },
            commands: [PickUpgrade({ offer: model.phase.offer, index })],
          }
        : { model },
    PressedEscape: () => {
      if (model.phase._tag === "CoopPlaying") {
        return setCoopMenu(model, !model.coop.menu);
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
      model.phase._tag === "CoopLobby" && model.phase.lobby.role === "host"
        ? { model, commands: [StartCoop()] }
        : { model },
    ClickedCoopUpgrade: ({ index }) =>
      model.phase._tag === "CoopLevelUp"
        ? {
            model: { ...model, phase: Phase.CoopPlaying() },
            commands: [PickCoopUpgrade({ offer: model.phase.offer, index })],
          }
        : { model },
    ClickedCoopResume: () =>
      model.phase._tag === "CoopPlaying"
        ? setCoopMenu(model, false)
        : { model },
    ClickedLeaveCoop: () =>
      isCoop(model.phase) ? leaveCoop(model) : { model },
    GotCoopLobby: ({ lobby }) =>
      model.phase._tag === "CoopConnecting" || model.phase._tag === "CoopLobby"
        ? { model: { ...model, phase: Phase.CoopLobby({ lobby }) } }
        : { model },
    // Co-op events can be queued behind a Leave: each counts only in the phase it belongs to.
    GotCoopStarted: ({ slot, names }) =>
      model.phase._tag === "CoopLobby"
        ? {
            model: {
              ...model,
              phase: Phase.CoopPlaying(),
              hud: emptyHud,
              coop: { ...emptyCoopRun, slot, names },
            },
          }
        : { model },
    GotCoopWaiting: ({ waitingFor }) =>
      model.phase._tag === "CoopPlaying" || model.phase._tag === "CoopLevelUp"
        ? { model: { ...model, coop: { ...model.coop, waitingFor } } }
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
    // The rules hold no pause for this player: its hero is down, or the run is over. The
    // app's pause flag follows them, so the screen doesn't say "paused" over a run that plays
    // on. The menu stays up: a player whose hero is down still needs its "Leave run".
    FailedToHoldCoopPause: () =>
      model.coop.paused
        ? { model: { ...model, coop: { ...model.coop, paused: false } } }
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
