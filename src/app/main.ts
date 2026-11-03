import { Layer } from 'effect'

import { makeContentServiceLayer } from '../kit/content/ContentService'
import { GameEngineLayer } from '../kit/engine/GameEngine'

export { Model } from './model'
export { init, update } from './update'
export { view } from './view'
export { subscriptions } from './subscriptions'

/** App-lifetime services, shared by every Command and Subscription. */
export const resources = GameEngineLayer.pipe(
  Layer.provideMerge(makeContentServiceLayer(`${import.meta.env.BASE_URL}content/`)),
)
