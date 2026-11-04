import type { SpriteSheet } from "@gamekit/render-three";
import { Context } from "effect";

/**
 * The app's loaded push-puzzle sheet, for `makePushPuzzleEngineLayer`. The app loads it at
 * startup and frees it when it ends; the game never does.
 */
export class PushPuzzleSheet extends Context.Service<
  PushPuzzleSheet,
  SpriteSheet
>()("@gamekit/push-puzzle/Sheet") {}
