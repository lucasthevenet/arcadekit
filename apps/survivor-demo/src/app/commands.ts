import { AudioSettings, AudioSystem } from "arcadekit/audio";
import { Effect, Schema } from "effect";
import { Command, Dom } from "foldkit";

/**
 * The app's Commands: Foldkit's contract, and the UI's only way to cause side effects. Each one
 * runs an Effect against the app's services and reports back with a Message.
 *
 * A Foldkit Command is not a command of the genre's: `PickUpgrade` and `PickCoopUpgrade` send the
 * genre's `ChooseUpgrade`, and `SetCoopPaused` its `HoldPause`.
 */
import { ChooseUpgrade, Hero, HoldPause, SurvivorsContent } from "#survivors";
import {
  SurvivorsCoop,
  SurvivorsEngine,
  SurvivorsSheet,
} from "#survivors/browser";

import { SurvivorsAudioSettings } from "./audio-settings";
import * as HeroRecords from "./hero-records";
import { Message } from "./message";
import { SurvivorsSave } from "./save";
import * as Sounds from "./sounds";
import { retryButtonId } from "./view";

/**
 * Loads the content and the sprite sheet, side by side: the game can't be played or drawn
 * without both. Either failing shows on the load-error screen, whose "Try again" runs this
 * again: each keeps its first success, so only what failed is fetched again.
 */
export const LoadContent = Command.define("LoadContent", {
  messages: [Message.LoadedContent, Message.FailedToLoadContent],
  execute: Effect.gen(function* () {
    // Both loads run to the end, so one failing doesn't cut the other short: what loaded is kept
    // for a retry.
    const [loadedContent, loadedSheet] = yield* Effect.all(
      [SurvivorsContent.load, SurvivorsSheet.load],
      { concurrency: "unbounded", mode: "result" }
    );
    const content = yield* Effect.fromResult(loadedContent);
    yield* Effect.fromResult(loadedSheet);
    return Message.LoadedContent({
      heroes: content.heroes.map(({ id, name, description, color }) => ({
        id,
        name,
        description,
        color,
      })),
    });
  }).pipe(
    Effect.catchTag(["ContentError", "SpriteSheetError"], (error) =>
      Effect.succeed(Message.FailedToLoadContent({ error: error.message }))
    )
  ),
});

/**
 * Focuses the load-error screen's "Try again" button once it is drawn, so Enter retries. Never
 * fails: if the screen is gone before it runs, nothing is focused.
 */
export const FocusRetry = Command.define("FocusRetry", {
  messages: [Message.CompletedFocusCommand],
  execute: Dom.focus(`#${retryButtonId}`).pipe(
    Effect.catchTag("ElementNotFound", () => Effect.void),
    Effect.as(Message.CompletedFocusCommand())
  ),
});

/** Starts a run with one hero. Playing again is the same: a new run. */
export const StartRun = Command.define("StartRun", {
  args: { heroId: Schema.String },
  messages: [Message.StartedRun, Message.FailedToStartRun],
  execute: ({ heroId }) =>
    Effect.gen(function* () {
      const content = yield* SurvivorsContent.load;
      const engine = yield* SurvivorsEngine;
      yield* engine.start({ content, heroIds: [heroId] });
      return Message.StartedRun();
    }).pipe(
      Effect.catchTag("ContentError", (error) =>
        Effect.succeed(Message.FailedToStartRun({ error: error.message }))
      )
    ),
});

/**
 * The player's pick, sent to the run as the genre's `ChooseUpgrade` command: the rules take it
 * at the start of the next step. The send waits for their answer, and every answer ends the
 * same way. The screen offers only the open offer's choices, so the rules don't refuse a pick
 * it makes; and a pick is dropped when the player quits or starts again before a step takes it.
 */
export const PickUpgrade = Command.define("PickUpgrade", {
  args: { offer: Schema.Int, index: Schema.Int },
  messages: [Message.CompletedEngineCommand],
  execute: ({ offer, index }) =>
    Effect.gen(function* () {
      const engine = yield* SurvivorsEngine;
      yield* engine.send(new ChooseUpgrade({ offer, index }));
      return Message.CompletedEngineCommand();
    }).pipe(
      Effect.catchTag(["OfferClosed", "NoSuchChoice"], () =>
        Effect.succeed(Message.CompletedEngineCommand())
      ),
      Effect.catchTag("CommandDropped", () =>
        Effect.succeed(Message.CompletedEngineCommand())
      )
    ),
});

/** Pauses or resumes the run: while paused, the engine draws without stepping. */
export const SetPaused = Command.define("SetPaused", {
  args: { paused: Schema.Boolean },
  messages: [Message.CompletedEngineCommand],
  execute: ({ paused }) =>
    Effect.gen(function* () {
      const engine = yield* SurvivorsEngine;
      yield* engine.setPaused(paused);
      return Message.CompletedEngineCommand();
    }),
});

/** Ends the run, as the app leaves it for the menu. Commands the run hadn't taken are dropped. */
export const EndRun = Command.define("EndRun", {
  messages: [Message.CompletedEngineCommand],
  execute: Effect.gen(function* () {
    const engine = yield* SurvivorsEngine;
    yield* engine.stop;
    return Message.CompletedEngineCommand();
  }),
});

/** Reads the save once, at startup. Never fails: a bad save reads as empty. */
export const LoadSave = Command.define("LoadSave", {
  messages: [Message.LoadedSave],
  execute: Effect.gen(function* () {
    const records = yield* (yield* SurvivorsSave).read;
    return Message.LoadedSave({ records });
  }),
});

/** Writes a run into the save, merged with what is stored. Never fails: a failed write is logged. */
export const SaveRun = Command.define("SaveRun", {
  args: { summary: Hero.Summary },
  messages: [Message.SavedRun],
  execute: ({ summary }) =>
    Effect.gen(function* () {
      const records = yield* (yield* SurvivorsSave).write(
        HeroRecords.fromSummary(summary)
      );
      return Message.SavedRun({ records });
    }),
});

// Co-op. The Co-op client reports what follows (the lobby, the start, a failure) as events, which
// the `coop` Subscription turns into Messages.

/**
 * Hosts a co-op room with the hero `heroId` as the lobby pick, after closing the seat before it,
 * if any. The client loads the content itself, so a Leave that follows cancels the load and no
 * room opens; a content load that fails is reported as `SeatFailed`.
 */
export const HostCoop = Command.define("HostCoop", {
  args: { heroId: Schema.String },
  messages: [Message.CompletedEngineCommand],
  execute: ({ heroId }) =>
    Effect.gen(function* () {
      yield* (yield* SurvivorsCoop).host(heroId);
      return Message.CompletedEngineCommand();
    }),
});

/** Joins the room with join code `code`, with the hero `heroId` as the lobby pick, as HostCoop hosts one. */
export const JoinCoop = Command.define("JoinCoop", {
  args: { code: Schema.String, heroId: Schema.String },
  messages: [Message.CompletedEngineCommand],
  execute: ({ code, heroId }) =>
    Effect.gen(function* () {
      yield* (yield* SurvivorsCoop).join(code, heroId);
      return Message.CompletedEngineCommand();
    }),
});

/** Changes the local player's lobby pick: its hero. Does nothing once the run has started. */
export const ChooseCoopHero = Command.define("ChooseCoopHero", {
  args: { heroId: Schema.String },
  messages: [Message.CompletedEngineCommand],
  execute: ({ heroId }) =>
    Effect.gen(function* () {
      yield* (yield* SurvivorsCoop).choose(heroId);
      return Message.CompletedEngineCommand();
    }),
});

/** The host's start: the run starts if the lobby can start (`canStart`), and nothing happens otherwise. */
export const StartCoop = Command.define("StartCoop", {
  messages: [Message.CompletedEngineCommand],
  execute: Effect.gen(function* () {
    yield* (yield* SurvivorsCoop).start;
    return Message.CompletedEngineCommand();
  }),
});

/**
 * The local hero's pick, sent to the co-op run as the genre's `ChooseUpgrade` command, the one
 * the single-player game sends its engine: it rides the hero's next step, and every peer's rules
 * take it at that step. Every answer ends the same way here: the screen offers only the open
 * offer's choices, so the rules don't refuse a pick it makes, and a pick is dropped when the
 * player leaves or the run stops first, which the co-op screens already show.
 */
export const PickCoopUpgrade = Command.define("PickCoopUpgrade", {
  args: { offer: Schema.Int, index: Schema.Int },
  messages: [Message.CompletedEngineCommand],
  execute: ({ offer, index }) =>
    Effect.gen(function* () {
      const coop = yield* SurvivorsCoop;
      yield* coop.send(new ChooseUpgrade({ offer, index }));
      return Message.CompletedEngineCommand();
    }).pipe(
      Effect.catchTag(["OfferClosed", "NoSuchChoice"], () =>
        Effect.succeed(Message.CompletedEngineCommand())
      ),
      Effect.catchTag("CommandDropped", () =>
        Effect.succeed(Message.CompletedEngineCommand())
      )
    ),
});

/**
 * Holds the run paused for everyone, or lets it go: the genre's `HoldPause` command, sent once.
 * The rules refuse it when the local hero isn't playing (it is down) or the run is over, and it
 * is dropped when there is no run to pause or the run stops first. Either way the pause the
 * player asked for isn't held, and the answer says so, so the app's own pause flag can follow
 * the rules. The run's menu, which asked for it, stays up.
 */
export const SetCoopPaused = Command.define("SetCoopPaused", {
  args: { paused: Schema.Boolean },
  messages: [Message.CompletedEngineCommand, Message.FailedToHoldCoopPause],
  execute: ({ paused }) =>
    Effect.gen(function* () {
      const coop = yield* SurvivorsCoop;
      yield* coop.send(new HoldPause({ held: paused }));
      return Message.CompletedEngineCommand();
    }).pipe(
      Effect.catchTag(["NotPlaying", "CommandDropped"], () =>
        Effect.succeed(Message.FailedToHoldCoopPause())
      )
    ),
});

/** Leaves the lobby or the run, and reports once its room, links, session and ticker have closed. */
export const LeaveCoop = Command.define("LeaveCoop", {
  messages: [Message.CompletedEngineCommand],
  execute: Effect.gen(function* () {
    yield* (yield* SurvivorsCoop).leave;
    return Message.CompletedEngineCommand();
  }),
});

// Sound. None of these fail or hold anything up: without sound, play goes on silently. The
// `sound` Subscription plays the music and applies the settings the Model holds.

/**
 * Loads every sound at startup. A sound that can't load is left out (the first such file is
 * logged), and the game plays on without it.
 */
export const LoadSounds = Command.define("LoadSounds", {
  messages: [Message.CompletedAudioCommand],
  execute: Effect.gen(function* () {
    yield* (yield* AudioSystem.AudioSystem)
      .load(Sounds.list)
      .pipe(
        Effect.catchTag("AudioLoadError", (error) =>
          Effect.logWarning(
            "A sound can't be loaded. Play goes on without it.",
            error.message
          )
        )
      );
    return Message.CompletedAudioCommand();
  }),
});

/** Reads the audio settings once, at startup. Missing or corrupt settings read as the defaults. */
export const LoadAudioSettings = Command.define("LoadAudioSettings", {
  messages: [Message.LoadedAudioSettings],
  execute: Effect.gen(function* () {
    const settings = yield* (yield* SurvivorsAudioSettings).read;
    return Message.LoadedAudioSettings({ settings });
  }),
});

/** Stores the audio settings, replacing what is there. A failed write is logged. */
export const SaveAudioSettings = Command.define("SaveAudioSettings", {
  args: { settings: AudioSettings.AudioSettings },
  messages: [Message.CompletedAudioCommand],
  execute: ({ settings }) =>
    Effect.gen(function* () {
      yield* (yield* SurvivorsAudioSettings).write(settings);
      return Message.CompletedAudioCommand();
    }),
});

/** The click of a button: a menu's, a hero's, an upgrade pick's or the mute's. */
export const PlayClick = Command.define("PlayClick", {
  messages: [Message.CompletedAudioCommand],
  execute: Effect.gen(function* () {
    (yield* AudioSystem.AudioSystem).play(Sounds.click);
    return Message.CompletedAudioCommand();
  }),
});
