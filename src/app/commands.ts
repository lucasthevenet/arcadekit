import { Effect, Schema } from 'effect'
import { Command } from 'foldkit'

import { ContentService } from '../kit/content/ContentService'
import { GameEngine } from '../kit/engine/GameEngine'
import { Message } from './message'

// Commands are the UI's only way to cause side effects. Each one runs an Effect
// against the app's services and reports back with a Message.

export const LoadContent = Command.define('LoadContent', {
  messages: [Message.LoadedContent, Message.FailedToLoadContent],
  execute: Effect.gen(function* () {
    const content = yield* (yield* ContentService).load
    return Message.LoadedContent({
      heroes: content.heroes.map(({ id, name, description, color }) => ({ id, name, description, color })),
    })
  }).pipe(Effect.catchTag('ContentError', error => Effect.succeed(Message.FailedToLoadContent({ error: error.message })))),
})

export const StartRun = Command.define('StartRun', {
  args: { heroId: Schema.String },
  messages: [Message.StartedRun, Message.FailedToStartRun],
  execute: ({ heroId }) =>
    Effect.gen(function* () {
      yield* (yield* GameEngine).startRun(heroId)
      return Message.StartedRun()
    }).pipe(Effect.catchTag('ContentError', error => Effect.succeed(Message.FailedToStartRun({ error: error.message })))),
})

export const ChooseUpgrade = Command.define('ChooseUpgrade', {
  args: { index: Schema.Number },
  messages: [Message.CompletedEngineCommand],
  execute: ({ index }) =>
    Effect.gen(function* () {
      yield* (yield* GameEngine).chooseUpgrade(index)
      return Message.CompletedEngineCommand()
    }),
})

export const SetPaused = Command.define('SetPaused', {
  args: { paused: Schema.Boolean },
  messages: [Message.CompletedEngineCommand],
  execute: ({ paused }) =>
    Effect.gen(function* () {
      yield* (yield* GameEngine).setPaused(paused)
      return Message.CompletedEngineCommand()
    }),
})

export const EndRun = Command.define('EndRun', {
  messages: [Message.CompletedEngineCommand],
  execute: Effect.gen(function* () {
    yield* (yield* GameEngine).endRun
    return Message.CompletedEngineCommand()
  }),
})
