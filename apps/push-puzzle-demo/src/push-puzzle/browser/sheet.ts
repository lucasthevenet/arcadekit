/**
 * Push-puzzle's sprite sheet, declared: the art its engine draws from, which the app loads once.
 */
import { Asset } from "arcadekit/content";
import { SpriteSheet } from "arcadekit/render-three";

/**
 * The app's push-puzzle sheet, with the first tag of each name in `Art.tags`. The engine draws
 * from it and never frees it: the app's end does.
 *
 * **When to use**
 *
 * In an app, to say where the sheet comes from, `PushPuzzleSheet.layer(SpriteSheet.fromUrl(url))`,
 * and to load it on the loading screen with `PushPuzzleSheet.load`, beside the levels.
 *
 * **Details**
 *
 * The first successful load is kept, and a failed one can be run again, so a "Try again" loads
 * only what failed. Each attach of the engine takes the sheet already loaded, or loads it.
 *
 * **Example** (Providing a sheet a test made)
 *
 * ```ts
 * import { PushPuzzleSheet } from "../push-puzzle/browser/index";
 * import { TestSpriteSheet } from "arcadekit/render-three/testing";
 * import { Effect } from "effect";
 *
 * const layer = PushPuzzleSheet.layer(Effect.succeed(TestSpriteSheet.fromTags({ floor: 1 })));
 * const sheet = Effect.runSync(PushPuzzleSheet.load.pipe(Effect.provide(layer)));
 * sheet.data.tags.has("floor"); // => true
 * ```
 *
 * @category declarations
 */
export class PushPuzzleSheet extends Asset<
  SpriteSheet.SpriteSheet,
  SpriteSheet.SpriteSheetError
>()("PushPuzzleSheet", { release: SpriteSheet.dispose }) {}
