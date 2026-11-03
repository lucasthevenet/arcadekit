import { Context, Effect, Layer, type Scope } from 'effect'

import { type ContentError, ContentService } from '../content/ContentService'
import { type EngineEvent, EngineCore } from './EngineCore'

/**
 * The engine as an Effect service. This is the seam between the Effect world
 * (UI, loading, networking) and the plain frame loop in EngineCore.
 * Scoped methods clean up automatically when their scope closes.
 */
export class GameEngine extends Context.Service<
  GameEngine,
  {
    /** Renders into `element` for as long as the scope is open. */
    readonly attach: (element: HTMLElement) => Effect.Effect<void, never, Scope.Scope>
    /** Calls `onEvent` for each engine event for as long as the scope is open. */
    readonly listen: (onEvent: (event: EngineEvent) => void) => Effect.Effect<void, never, Scope.Scope>
    readonly startRun: (heroId: string) => Effect.Effect<void, ContentError>
    readonly chooseUpgrade: (index: number) => Effect.Effect<void>
    readonly setPaused: (paused: boolean) => Effect.Effect<void>
    readonly endRun: Effect.Effect<void>
  }
>()('survivor-kit/GameEngine') {}

export const GameEngineLayer = Layer.effect(
  GameEngine,
  Effect.gen(function* () {
    const content = yield* ContentService
    const core = new EngineCore()
    return {
      attach: element =>
        Effect.acquireRelease(
          Effect.sync(() => core.attach(element)),
          detach => Effect.sync(detach),
        ).pipe(Effect.asVoid),
      listen: onEvent =>
        Effect.acquireRelease(
          Effect.sync(() => core.subscribe(onEvent)),
          unsubscribe => Effect.sync(unsubscribe),
        ).pipe(Effect.asVoid),
      startRun: heroId =>
        Effect.flatMap(content.load, loaded => Effect.sync(() => core.startRun(loaded, heroId))),
      chooseUpgrade: index => Effect.sync(() => core.chooseUpgrade(index)),
      setPaused: paused => Effect.sync(() => core.setPaused(paused)),
      endRun: Effect.sync(() => core.endRun()),
    }
  }),
)
