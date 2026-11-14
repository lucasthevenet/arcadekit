/**
 * Survivors' sprite sheet, declared: the art its engine draws from, for one player and in co-op,
 * which the app loads once.
 */
import { Asset } from "arcadekit/content";
import { SpriteSheet } from "arcadekit/render-three";

/**
 * The app's survivors sheet, with every tag the view draws for its content (`Art.tags`). The
 * engine draws from it, for one player and in co-op, and never frees it: the app's end does.
 *
 * **When to use**
 *
 * In an app, to say where the sheet comes from, `SurvivorsSheet.layer(SpriteSheet.fromUrl(url))`,
 * and to load it on the loading screen with `SurvivorsSheet.load`, beside the content.
 *
 * **Details**
 *
 * The first successful load is kept, and a failed one can be run again, so a "Try again" loads
 * only what failed. Each attach of the engine or the Co-op client takes the sheet already loaded,
 * or loads it.
 *
 * **Example** (Providing a sheet a test made)
 *
 * ```ts
 * import { SurvivorsSheet } from "../survivors/browser/index";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 * import { Effect } from "effect";
 *
 * const layer = SurvivorsSheet.layer(Effect.succeed(TestSpriteSheet.fromTags({ shadow: 1 })));
 * const sheet = Effect.runSync(SurvivorsSheet.load.pipe(Effect.provide(layer)));
 * sheet.data.tags.has("shadow"); // => true
 * ```
 *
 * @category declarations
 */
export class SurvivorsSheet extends Asset<
  SpriteSheet.SpriteSheet,
  SpriteSheet.SpriteSheetError
>()("SurvivorsSheet", { release: SpriteSheet.dispose }) {}
