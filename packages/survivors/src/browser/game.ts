import { InputController, MOVE_AXES } from '@gamekit/input'
import { type GameDefinition, type GameEngine, makeGameEngine } from '@gamekit/runtime'
import { Context, Layer } from 'effect'

import {
  type SurvivorsConfig,
  type SurvivorsEvent,
  type SurvivorsInput,
  type World,
  createWorld,
  hudSnapshot,
  step,
} from '../world'
import { SurvivorsView } from './view'

/** The survivors genre as a @gamekit/runtime game. */
export const survivorsGame: GameDefinition<SurvivorsConfig, World, SurvivorsInput, SurvivorsEvent> = {
  stepSeconds: 1 / 60,
  create: createWorld,
  step,
  drainEvents: world => world.events.drain(),
  sample: { everyMs: 100, read: world => ({ type: 'hud', hud: hudSnapshot(world) }) },
  createInput: surface => {
    const controller = new InputController(surface, { axes: MOVE_AXES, buttons: {} })
    return {
      read: () => ({ moveX: controller.axis('moveX'), moveZ: controller.axis('moveY') }),
      endFrame: () => controller.endFrame(),
      dispose: () => controller.dispose(),
    }
  },
  createView: container => new SurvivorsView(container),
}

export class SurvivorsEngine extends Context.Service<
  SurvivorsEngine,
  GameEngine<SurvivorsConfig, World, SurvivorsEvent>
>()('@gamekit/survivors/Engine') {}

export const SurvivorsEngineLayer = Layer.sync(SurvivorsEngine, () => makeGameEngine(survivorsGame))
