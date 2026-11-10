import type { ContentError } from "arcadekit/content";
import type { CoopGame } from "arcadekit/net/browser";
import type { SpriteSheetError } from "arcadekit/render-three";
import { Effect } from "effect";

import { survivorsCoopRules } from "../coop";
import type { SurvivorsCoop } from "../coop";
import type { GameContent } from "../schema";
import type { SurvivorsArt } from "./art";
import { heroDevice } from "./device";
import { survivorsViews } from "./game";
import type { SurvivorsGameSound } from "./game";

/** What a survivors Co-op game is made with. */
interface SurvivorsCoopGameOptions {
  /** The run's content: the app's content load. Run once per seat. */
  readonly content: Effect.Effect<GameContent, ContentError>;
  /**
   * The art the run is drawn with: the app's load of its sheet, such as the engine loader's
   * (`SurvivorsEngine`), so one sheet serves both. Run once per attach; the view never frees it.
   */
  readonly art: Effect.Effect<SurvivorsArt, SpriteSheetError>;
  /**
   * What the run's sounds play through: every peer hears the whole fight, its own hero's hurt
   * and down loudest. Without it the run is silent.
   */
  readonly sound?: SurvivorsGameSound;
}

/**
 * Survivors as a Co-op game for `arcadekit/net/browser`'s `makeCoopClient`: the Co-op rules,
 * the content, and a presentation whose view follows the local player's hero. The view and the
 * sound view read the local slot on every frame, so one view serves the lobby and the run.
 */
export const makeSurvivorsCoopGame = ({
  content,
  art,
  sound,
}: SurvivorsCoopGameOptions): CoopGame<SurvivorsCoop, SpriteSheetError> => ({
  ...survivorsCoopRules,
  content,
  presentation: art.pipe(
    Effect.map((loaded) => ({
      createInput: heroDevice,
      createView: (container, local) =>
        survivorsViews(container, loaded, sound, () => local.slot),
    }))
  ),
});
