import {
  RunSummary,
  SurvivorsContent,
  chooseUpgrade,
} from "@gamekit/survivors";
import { SurvivorsEngine } from "@gamekit/survivors/browser";
import { Effect, Schema } from "effect";
import { Command } from "foldkit";

import { Message } from "./message";
import { Save } from "./save";

// Commands are the UI's only way to cause side effects. Each one runs an Effect
// against the app's services and reports back with a Message.

export const LoadContent = Command.define("LoadContent", {
  messages: [Message.LoadedContent, Message.FailedToLoadContent],
  execute: Effect.gen(function* () {
    const content = yield* (yield* SurvivorsContent).load;
    return Message.LoadedContent({
      heroes: content.heroes.map(({ id, name, description, color }) => ({
        id,
        name,
        description,
        color,
      })),
    });
  }).pipe(
    Effect.catchTag("ContentError", (error) =>
      Effect.succeed(Message.FailedToLoadContent({ error: error.message }))
    )
  ),
});

export const StartRun = Command.define("StartRun", {
  args: { heroId: Schema.String },
  messages: [Message.StartedRun, Message.FailedToStartRun],
  execute: ({ heroId }) =>
    Effect.gen(function* () {
      const content = yield* (yield* SurvivorsContent).load;
      yield* (yield* SurvivorsEngine).start({ content, heroIds: [heroId] });
      return Message.StartedRun();
    }).pipe(
      Effect.catchTag("ContentError", (error) =>
        Effect.succeed(Message.FailedToStartRun({ error: error.message }))
      )
    ),
});

export const ChooseUpgrade = Command.define("ChooseUpgrade", {
  args: { index: Schema.Number },
  messages: [Message.CompletedEngineCommand],
  execute: ({ index }) =>
    Effect.gen(function* () {
      yield* (yield* SurvivorsEngine).modify((world) =>
        chooseUpgrade(world, 0, index)
      );
      return Message.CompletedEngineCommand();
    }),
});

export const SetPaused = Command.define("SetPaused", {
  args: { paused: Schema.Boolean },
  messages: [Message.CompletedEngineCommand],
  execute: ({ paused }) =>
    Effect.gen(function* () {
      yield* (yield* SurvivorsEngine).setPaused(paused);
      return Message.CompletedEngineCommand();
    }),
});

export const EndRun = Command.define("EndRun", {
  messages: [Message.CompletedEngineCommand],
  execute: Effect.gen(function* () {
    yield* (yield* SurvivorsEngine).stop;
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

/** Writes a run into the save, merged with what is stored. Never fails: a failed write is logged. */
export const SaveRun = Command.define("SaveRun", {
  args: { summary: RunSummary },
  messages: [Message.SavedRun],
  execute: ({ summary }) =>
    Effect.gen(function* () {
      const records = yield* (yield* Save).recordRun(summary);
      return Message.SavedRun({ records });
    }),
});
