import { Effect, type Scope } from 'effect'

import type { GameDefinition } from './definition'
import { GameDriver } from './driver'

/**
 * The Effect-facing API of a running game. Scoped methods clean up when their scope closes.
 *
 * Each game declares its own service key for it, so several games (or engines) can coexist:
 *
 * ```ts
 * class MyEngine extends Context.Service<MyEngine, GameEngine<Config, State, Event>>()('my-game/Engine') {}
 * const MyEngineLayer = Layer.sync(MyEngine, () => makeGameEngine(myGameDefinition))
 * ```
 */
export interface GameEngine<Config, State, Event> {
  /** Renders into `element` and reads input from it while the scope is open. */
  readonly attach: (element: HTMLElement) => Effect.Effect<void, never, Scope.Scope>
  /** Calls `onEvent` for every game event while the scope is open. */
  readonly listen: (onEvent: (event: Event) => void) => Effect.Effect<void, never, Scope.Scope>
  /** Starts a new run. Without a seed, a random one is used. */
  readonly start: (config: Config, seed?: number) => Effect.Effect<void>
  /** Changes the running game's state, then reports any events that produced. Does nothing with no run. */
  readonly modify: (change: (state: State) => void) => Effect.Effect<void>
  readonly setPaused: (paused: boolean) => Effect.Effect<void>
  readonly stop: Effect.Effect<void>
}

export const makeGameEngine = <Config, State, Input, Event>(
  definition: GameDefinition<Config, State, Input, Event>,
): GameEngine<Config, State, Event> => {
  const driver = new GameDriver(definition)
  return {
    attach: element =>
      Effect.acquireRelease(
        Effect.sync(() => driver.attach(element)),
        detach => Effect.sync(detach),
      ).pipe(Effect.asVoid),
    listen: onEvent =>
      Effect.acquireRelease(
        Effect.sync(() => driver.subscribe(onEvent)),
        unsubscribe => Effect.sync(unsubscribe),
      ).pipe(Effect.asVoid),
    start: (config, seed) =>
      Effect.sync(() => driver.start(config, seed ?? (Math.random() * 2 ** 32) >>> 0)),
    modify: change => Effect.sync(() => driver.modify(change)),
    setPaused: paused => Effect.sync(() => driver.setPaused(paused)),
    stop: Effect.sync(() => driver.stop()),
  }
}
