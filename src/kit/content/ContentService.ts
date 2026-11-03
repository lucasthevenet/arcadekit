import { Context, Data, Effect, Layer, Schema } from 'effect'

import { GameContent, findBrokenReferences } from './schema'

export class ContentError extends Data.TaggedError('ContentError')<{
  readonly message: string
}> {}

/** The JSON files that make up a game, keyed by the GameContent field they fill. */
const CONTENT_FILES = {
  rules: 'rules.json',
  heroes: 'heroes.json',
  enemies: 'enemies.json',
  weapons: 'weapons.json',
  passives: 'passives.json',
  waves: 'waves.json',
} as const

const fetchJson = (baseUrl: string, file: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${baseUrl}${file}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return (await response.json()) as unknown
    },
    catch: cause => new ContentError({ message: `Could not load ${file}: ${String(cause)}` }),
  })

/** Loads and validates the game's content files. The result is cached after the first load. */
export class ContentService extends Context.Service<
  ContentService,
  { readonly load: Effect.Effect<GameContent, ContentError> }
>()('survivor-kit/ContentService') {}

export const makeContentServiceLayer = (baseUrl: string) =>
  Layer.effect(
    ContentService,
    Effect.gen(function* () {
      const loadOnce = Effect.gen(function* () {
        const raw = yield* Effect.all(
          Object.fromEntries(
            Object.entries(CONTENT_FILES).map(([key, file]) => [key, fetchJson(baseUrl, file)]),
          ),
          { concurrency: 'unbounded' },
        )
        const content = yield* Schema.decodeUnknownEffect(GameContent)(raw).pipe(
          Effect.mapError(error => new ContentError({ message: `Invalid content: ${error.message}` })),
        )
        const broken = findBrokenReferences(content)
        if (broken.length > 0) {
          return yield* new ContentError({ message: `Broken references: ${broken.join('; ')}` })
        }
        return content
      })
      return { load: yield* Effect.cached(loadOnce) }
    }),
  )
