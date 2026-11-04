import { PushPuzzleContent } from "@gamekit/push-puzzle";
import { PushPuzzleEngine } from "@gamekit/push-puzzle/browser";
import { Effect, Schema } from "effect";
import { Command } from "foldkit";

import { Message } from "./message";
import { Save } from "./save";

// Commands are the UI's only way to cause side effects. Each one runs an Effect
// against the app's services and reports back with a Message.

export const LoadContent = Command.define("LoadContent", {
  messages: [Message.LoadedContent, Message.FailedToLoadContent],
  execute: Effect.gen(function* () {
    const content = yield* (yield* PushPuzzleContent).load;
    return Message.LoadedContent({
      levels: content.levels.map(({ id, name }) => ({ id, name })),
    });
  }).pipe(
    Effect.catchTag("ContentError", (error) =>
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
      yield* (yield* PushPuzzleEngine).start({ content, levelId });
      return Message.StartedRun();
    }).pipe(
      Effect.catchTag("ContentError", (error) =>
        Effect.succeed(Message.FailedToStartRun({ error: error.message }))
      )
    ),
});

export const EndRun = Command.define("EndRun", {
  messages: [Message.CompletedEngineCommand],
  execute: Effect.gen(function* () {
    yield* (yield* PushPuzzleEngine).stop;
    return Message.CompletedEngineCommand();
  }),
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
