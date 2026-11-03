import { Effect, Queue, Schema, Stream } from 'effect'
import { Mount, Subscription } from 'foldkit'

import type { EngineEvent } from '../kit/engine/EngineCore'
import { GameEngine } from '../kit/engine/GameEngine'
import { Message } from './message'
import type { Model } from './model'

export const VIEWPORT_ID = 'game-viewport'

/** Reports that the game's DOM element now exists. The engine subscription below waits for this. */
export const GameViewport = Mount.define('GameViewport', {
  messages: [Message.MountedViewport],
  execute: () => Effect.succeed(Message.MountedViewport()),
})

const toMessage = (event: EngineEvent): Message => {
  switch (event.type) {
    case 'hud':
      return Message.GotHud({ hud: event.hud })
    case 'levelUp':
      return Message.GotLevelUp({ choices: event.choices.map(choice => ({ ...choice })) })
    case 'runEnded':
      return Message.GotRunEnded({ summary: event.summary })
  }
}

export const subscriptions = Subscription.make<Model, Message, GameEngine>()(entry => ({
  /**
   * While the viewport exists: attach the engine to it and turn engine events into Messages.
   * When this subscription's scope closes, the engine detaches and stops rendering.
   */
  engine: entry(
    { isViewportMounted: Schema.Boolean },
    {
      modelToDependencies: model => ({ isViewportMounted: model.isViewportMounted }),
      dependenciesToStream: ({ isViewportMounted }) =>
        isViewportMounted
          ? Stream.callback<Message, never, GameEngine>(queue =>
              Effect.gen(function* () {
                const engine = yield* GameEngine
                const element = document.getElementById(VIEWPORT_ID)
                if (!element) return yield* Effect.die(new Error(`#${VIEWPORT_ID} is missing`))
                yield* engine.listen(event => Queue.offerUnsafe(queue, toMessage(event)))
                yield* engine.attach(element)
                return yield* Effect.never
              }),
            )
          : Stream.empty,
    },
  ),

  /** Escape toggles pause, but only during a run. */
  escapeKey: entry(
    { canPause: Schema.Boolean },
    {
      modelToDependencies: model => ({
        canPause: model.phase._tag === 'Playing' || model.phase._tag === 'Paused',
      }),
      dependenciesToStream: ({ canPause }) =>
        canPause
          ? Stream.callback<Message>(queue =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  const onKey = (event: KeyboardEvent) => {
                    if (event.code === 'Escape' || event.code === 'KeyP') Queue.offerUnsafe(queue, Message.PressedEscape())
                  }
                  window.addEventListener('keydown', onKey)
                  return onKey
                }),
                onKey => Effect.sync(() => window.removeEventListener('keydown', onKey)),
              ).pipe(Effect.andThen(Effect.never)),
            )
          : Stream.empty,
    },
  ),
}))
