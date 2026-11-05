import { Audio, AudioSettings, applyAudioSettings } from "@gamekit/audio";
import { PushPuzzleContent } from "@gamekit/push-puzzle";
import type {
  PushPuzzleConfig,
  PushPuzzleEvent,
  Puzzle,
} from "@gamekit/push-puzzle";
import { PushPuzzleEngine } from "@gamekit/push-puzzle/browser";
import { engineOf } from "@gamekit/runtime/browser";
import type { GameEngine } from "@gamekit/runtime/browser";
import { Effect, Schema } from "effect";
import { Command } from "foldkit";

import { AudioSettingsStorage, CLICK, MUSIC, SOUND_LIST } from "./audio";
import { Message } from "./message";
import { Save } from "./save";

// Commands are the UI's only way to cause side effects. Each one runs an Effect
// against the app's services and reports back with a Message.

/**
 * Loads the levels and the sprite sheet, side by side: the game can't be played or drawn
 * without both. Loading the sheet makes the engine (ADR-0015). Either failing shows on the
 * loading screen.
 */
export const LoadContent = Command.define("LoadContent", {
  messages: [Message.LoadedContent, Message.FailedToLoadContent],
  execute: Effect.gen(function* () {
    const [content] = yield* Effect.all(
      [(yield* PushPuzzleContent).load, (yield* PushPuzzleEngine).load],
      { concurrency: "unbounded" }
    );
    return Message.LoadedContent({
      levels: content.levels.map(({ id, name }) => ({ id, name })),
    });
  }).pipe(
    Effect.catchTag(["ContentError", "SpriteSheetError"], (error) =>
      Effect.succeed(Message.FailedToLoadContent({ error: error.message }))
    )
  ),
});

/** Starts a run of one level. Restarting is the same: a new run of the same level. */
export const StartLevel = Command.define("StartLevel", {
  args: { levelId: Schema.String },
  messages: [Message.StartedRun, Message.FailedToStartRun],
  execute: ({ levelId }) =>
    Effect.gen(function* () {
      const content = yield* (yield* PushPuzzleContent).load;
      const engine = yield* engineOf(PushPuzzleEngine);
      yield* engine.start({ content, levelId });
      return Message.StartedRun();
    }).pipe(
      Effect.catchTag(["ContentError", "SpriteSheetError"], (error) =>
        Effect.succeed(Message.FailedToStartRun({ error: error.message }))
      )
    ),
});

/**
 * Runs `use` on the engine. The engine comes through the sheet's load, so this can fail only if
 * no load ever succeeded (then there is no run). That failure is reported, never dropped.
 */
const withEngine = (
  use: (
    engine: GameEngine<PushPuzzleConfig, Puzzle, PushPuzzleEvent>
  ) => Effect.Effect<void>
) =>
  engineOf(PushPuzzleEngine).pipe(
    Effect.flatMap(use),
    Effect.as(Message.CompletedEngineCommand()),
    Effect.catchTag("SpriteSheetError", (error) =>
      Effect.succeed(Message.FailedToStartRun({ error: error.message }))
    )
  );

export const EndRun = Command.define("EndRun", {
  messages: [Message.CompletedEngineCommand, Message.FailedToStartRun],
  execute: withEngine((engine) => engine.stop),
});

/** Reads the save once, at startup. Never fails: a bad save reads as empty. */
export const LoadSave = Command.define("LoadSave", {
  messages: [Message.LoadedSave],
  execute: Effect.gen(function* () {
    const records = yield* (yield* Save).load;
    return Message.LoadedSave({ records });
  }),
});

/** Writes a solve into the save, merged with what is stored. Never fails: a failed write is logged. */
export const SaveSolve = Command.define("SaveSolve", {
  args: { levelId: Schema.String, moves: Schema.Number },
  messages: [Message.SavedSolve],
  execute: ({ levelId, moves }) =>
    Effect.gen(function* () {
      const records = yield* (yield* Save).recordSolve(levelId, moves);
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
    const audio = yield* Audio;
    audio.playMusic(MUSIC);
    yield* audio
      .load(SOUND_LIST)
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
    const settings = yield* (yield* AudioSettingsStorage).load;
    applyAudioSettings(yield* Audio, settings);
    return Message.LoadedAudioSettings({ settings });
  }),
});

/** Applies changed audio settings and saves them. Never fails: a failed write is logged. */
export const ChangeAudioSettings = Command.define("ChangeAudioSettings", {
  args: { settings: AudioSettings },
  messages: [Message.CompletedAudioCommand],
  execute: ({ settings }) =>
    Effect.gen(function* () {
      applyAudioSettings(yield* Audio, settings);
      yield* (yield* AudioSettingsStorage).save(settings);
      return Message.CompletedAudioCommand();
    }),
});

/** The click of a menu button. */
export const PlayClick = Command.define("PlayClick", {
  messages: [Message.CompletedAudioCommand],
  execute: Effect.gen(function* () {
    (yield* Audio).play(CLICK);
    return Message.CompletedAudioCommand();
  }),
});
