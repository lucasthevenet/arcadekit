import { AudioSettings, AudioSystem } from "arcadekit/audio";
import { Effect, Schema } from "effect";
import { Command, Dom } from "foldkit";

/**
 * The app's Commands: Foldkit's contract, and the UI's only way to cause side effects. Each one
 * runs an Effect against the app's services and reports back with a Message.
 */
import { PushPuzzleContent } from "#push-puzzle";
import { PushPuzzleEngine, PushPuzzleSheet } from "#push-puzzle/browser";

import { PushPuzzleAudioSettings } from "./audio-settings";
import * as LevelRecords from "./level-records";
import { Message } from "./message";
import { PushPuzzleSave } from "./save";
import * as Sounds from "./sounds";
import { retryButtonId } from "./view";

/**
 * Loads the levels and the sprite sheet, side by side: the game can't be played or drawn
 * without both. Either failing shows on the load-error screen, whose "Try again" runs this
 * again: each keeps its first success, so only what failed is fetched again.
 */
export const LoadContent = Command.define("LoadContent", {
  messages: [Message.LoadedContent, Message.FailedToLoadContent],
  execute: Effect.gen(function* () {
    // Both loads run to the end, so one failing doesn't cut the other short: what loaded is kept
    // for a retry.
    const [loadedContent, loadedSheet] = yield* Effect.all(
      [PushPuzzleContent.load, PushPuzzleSheet.load],
      { concurrency: "unbounded", mode: "result" }
    );
    const content = yield* Effect.fromResult(loadedContent);
    yield* Effect.fromResult(loadedSheet);
    return Message.LoadedContent({
      levels: content.levels.map(({ id, name }) => ({ id, name })),
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

/** Starts a run of one level. Restarting is the same: a new run of the same level. */
export const StartLevel = Command.define("StartLevel", {
  args: { levelId: Schema.String },
  messages: [Message.StartedRun, Message.FailedToStartRun],
  execute: ({ levelId }) =>
    Effect.gen(function* () {
      const content = yield* PushPuzzleContent.load;
      const engine = yield* PushPuzzleEngine;
      yield* engine.start({ content, levelId });
      return Message.StartedRun();
    }).pipe(
      Effect.catchTag("ContentError", (error) =>
        Effect.succeed(Message.FailedToStartRun({ error: error.message }))
      )
    ),
});

/** Stops the run, as the app leaves it for level select. */
export const EndRun = Command.define("EndRun", {
  messages: [Message.CompletedEngineCommand],
  execute: Effect.gen(function* () {
    const engine = yield* PushPuzzleEngine;
    yield* engine.stop;
    return Message.CompletedEngineCommand();
  }),
});

/** Reads the save once, at startup. Never fails: a bad save reads as empty. */
export const LoadSave = Command.define("LoadSave", {
  messages: [Message.LoadedSave],
  execute: Effect.gen(function* () {
    const records = yield* (yield* PushPuzzleSave).read;
    return Message.LoadedSave({ records });
  }),
});

/** Writes a solve into the save, merged with what is stored. Never fails: a failed write is logged. */
export const SaveSolve = Command.define("SaveSolve", {
  args: { levelId: Schema.String, moves: Schema.Number },
  messages: [Message.SavedSolve],
  execute: ({ levelId, moves }) =>
    Effect.gen(function* () {
      const save = yield* PushPuzzleSave;
      const records = yield* save.write(LevelRecords.fromSolve(levelId, moves));
      return Message.SavedSolve({ records });
    }),
});

/**
 * Starts the music and loads the sounds, once, at startup. Nothing waits on it: the music
 * starts once its file is in and the player's first gesture unlocks audio. A sound that
 * can't load is left out (the first such file is logged), and the game plays on without it.
 */
export const LoadSounds = Command.define("LoadSounds", {
  messages: [Message.CompletedAudioCommand],
  execute: Effect.gen(function* () {
    const audio = yield* AudioSystem.AudioSystem;
    audio.playMusic(Sounds.music);
    yield* audio
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

/** Reads the saved audio settings once, at startup, and applies them. Never fails. */
export const LoadAudioSettings = Command.define("LoadAudioSettings", {
  messages: [Message.LoadedAudioSettings],
  execute: Effect.gen(function* () {
    const settings = yield* (yield* PushPuzzleAudioSettings).read;
    AudioSystem.applySettings(yield* AudioSystem.AudioSystem, settings);
    return Message.LoadedAudioSettings({ settings });
  }),
});

/** Applies changed audio settings and saves them. Never fails: a failed write is logged. */
export const ChangeAudioSettings = Command.define("ChangeAudioSettings", {
  args: { settings: AudioSettings.AudioSettings },
  messages: [Message.CompletedAudioCommand],
  execute: ({ settings }) =>
    Effect.gen(function* () {
      AudioSystem.applySettings(yield* AudioSystem.AudioSystem, settings);
      yield* (yield* PushPuzzleAudioSettings).write(settings);
      return Message.CompletedAudioCommand();
    }),
});

/** The click of a menu button. */
export const PlayClick = Command.define("PlayClick", {
  messages: [Message.CompletedAudioCommand],
  execute: Effect.gen(function* () {
    (yield* AudioSystem.AudioSystem).play(Sounds.click);
    return Message.CompletedAudioCommand();
  }),
});
