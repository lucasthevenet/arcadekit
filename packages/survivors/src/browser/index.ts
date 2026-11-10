// Browser-only parts of the survivors genre: the engine an app runs for one player, the Co-op
// game it gives the kit's Co-op client, and the art, sound and view pieces.
export { type SurvivorsArt, missingSpriteTags } from "./art";
export { makeSurvivorsCoopGame } from "./coop";
export {
  SurvivorsEngine,
  type SurvivorsEngineLoader,
  type SurvivorsGameSound,
  makeSurvivorsEngineLayer,
  // The genre's GameDefinition, which the README documents for an app that drives the game
  // without makeSurvivorsEngineLayer.
  makeSurvivorsGame,
} from "./game";
export { SurvivorsSoundView, type SurvivorsSounds } from "./sound";
export { SurvivorsView } from "./view";
