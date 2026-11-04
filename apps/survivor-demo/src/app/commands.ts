import {
  RunSummary,
  SurvivorsContent,
  chooseUpgrade,
} from "@gamekit/survivors";
import { SurvivorsEngine } from "@gamekit/survivors/browser";
import { Effect, Schema } from "effect";
import { Command } from "foldkit";

import { Coop } from "./coop";
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

// Co-op. The co-op client reports what follows (the lobby, the start, errors) as events, which
// the coop Subscription turns into Messages.

export const HostCoop = Command.define("HostCoop", {
  args: { heroId: Schema.String },
  messages: [Message.CompletedEngineCommand, Message.GotCoopFailed],
  execute: ({ heroId }) =>
    Effect.gen(function* () {
      const content = yield* (yield* SurvivorsContent).load;
      yield* (yield* Coop).host(content, heroId);
      return Message.CompletedEngineCommand();
    }).pipe(
      Effect.catchTag("ContentError", (error) =>
        Effect.succeed(Message.GotCoopFailed({ error: error.message }))
      )
    ),
});

export const JoinCoop = Command.define("JoinCoop", {
  args: { code: Schema.String, heroId: Schema.String },
  messages: [Message.CompletedEngineCommand, Message.GotCoopFailed],
  execute: ({ code, heroId }) =>
    Effect.gen(function* () {
      const content = yield* (yield* SurvivorsContent).load;
      yield* (yield* Coop).join(content, code, heroId);
      return Message.CompletedEngineCommand();
    }).pipe(
      Effect.catchTag("ContentError", (error) =>
        Effect.succeed(Message.GotCoopFailed({ error: error.message }))
      )
    ),
});

export const ChooseCoopHero = Command.define("ChooseCoopHero", {
  args: { heroId: Schema.String },
  messages: [Message.CompletedEngineCommand],
  execute: ({ heroId }) =>
    Effect.gen(function* () {
      yield* (yield* Coop).chooseHero(heroId);
      return Message.CompletedEngineCommand();
    }),
});

export const StartCoop = Command.define("StartCoop", {
  messages: [Message.CompletedEngineCommand],
  execute: Effect.gen(function* () {
    yield* (yield* Coop).start;
    return Message.CompletedEngineCommand();
  }),
});

/** The local hero's pick, as its step input: every peer applies it at the same step. */
export const ChooseCoopUpgrade = Command.define("ChooseCoopUpgrade", {
  args: { offer: Schema.Number, index: Schema.Number },
  messages: [Message.CompletedEngineCommand],
  execute: ({ offer, index }) =>
    Effect.gen(function* () {
      yield* (yield* Coop).pickUpgrade(offer, index);
      return Message.CompletedEngineCommand();
    }),
});

/** Holds the run paused for everyone, through the local hero's pause flag in its step input. */
export const SetCoopPaused = Command.define("SetCoopPaused", {
  args: { paused: Schema.Boolean },
  messages: [Message.CompletedEngineCommand],
  execute: ({ paused }) =>
    Effect.gen(function* () {
      yield* (yield* Coop).setPaused(paused);
      return Message.CompletedEngineCommand();
    }),
});

export const LeaveCoop = Command.define("LeaveCoop", {
  messages: [Message.CompletedEngineCommand],
  execute: Effect.gen(function* () {
    yield* (yield* Coop).leave;
    return Message.CompletedEngineCommand();
  }),
});
