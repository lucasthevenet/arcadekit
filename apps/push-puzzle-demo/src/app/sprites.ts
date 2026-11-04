import { PushPuzzleSheet } from "@gamekit/push-puzzle/browser";
import { loadSpriteSheet, makeSpriteSheet } from "@gamekit/render-three";
import type {
  SpriteSheet,
  SpriteSheetData,
  SpriteSheetError,
} from "@gamekit/render-three";
import { Context, Effect, Layer, Result } from "effect";

// This game's art: one sheet in public/sprites, loaded once at startup and kept for the app's
// lifetime (ADR-0015). The engine draws from it; LoadContent reports a failed load.

export const SHEET_URL = `${import.meta.env.BASE_URL}sprites/push-puzzle.json`;

/** The sheet's load, done once when the app's services are built. */
export class Sprites extends Context.Service<
  Sprites,
  {
    /** The loaded sheet, or the error that stopped it loading. */
    readonly sheet: Effect.Effect<SpriteSheet, SpriteSheetError>;
  }
>()("push-puzzle-demo/Sprites") {}

/**
 * Stands in for the sheet when it failed to load, so the engine can still be built. The app
 * then stays on its error screen, so nothing is drawn from it.
 */
const blankSheet = (): SpriteSheet => {
  const data: SpriteSheetData = {
    image: "blank",
    width: 1,
    height: 1,
    frames: [
      {
        name: "blank",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        offsetX: 0,
        offsetY: 0,
        sourceWidth: 1,
        sourceHeight: 1,
        duration: 0.1,
      },
    ],
    frameByName: new Map(),
    tags: new Map(),
  };
  return makeSpriteSheet(data, new ImageData(1, 1));
};

/** Loads the sheet from `url`, and frees it when the app ends. Never fails: see `Sprites`. */
export const makeSpritesLayer = (
  url: string
): Layer.Layer<Sprites | PushPuzzleSheet> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const loaded = yield* Effect.result(loadSpriteSheet(url));
      const sheet = Result.isSuccess(loaded) ? loaded.success : blankSheet();
      yield* Effect.addFinalizer(() => Effect.sync(sheet.dispose));
      return Context.make(Sprites, {
        sheet: Result.isSuccess(loaded)
          ? Effect.succeed(sheet)
          : Effect.fail(loaded.failure),
      }).pipe(Context.add(PushPuzzleSheet, sheet));
    })
  );

export const SpritesLayer = makeSpritesLayer(SHEET_URL);
