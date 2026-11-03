import { type ContentLoader, type ContentSource, makeContentLoader } from '@gamekit/content'
import { Context, Layer } from 'effect'

import { GameContent, findBrokenReferences } from './schema'

/** The file that fills each part of the content. Paths are relative to the content source. */
export const CONTENT_FILES = {
  rules: 'rules.json',
  heroes: 'heroes.json',
  enemies: 'enemies.json',
  weapons: 'weapons.json',
  passives: 'passives.json',
  waves: 'waves.json',
} as const

/** Loads and validates a survivors game's content. Cached after the first load. */
export class SurvivorsContent extends Context.Service<SurvivorsContent, ContentLoader<GameContent>>()(
  '@gamekit/survivors/Content',
) {}

export const makeSurvivorsContentLayer = (source: ContentSource) =>
  Layer.effect(
    SurvivorsContent,
    makeContentLoader({ schema: GameContent, files: CONTENT_FILES, source, validate: findBrokenReferences }),
  )
