// Browser-only parts of the push-puzzle genre: the engine an app runs, its cue table and sprite tags.
export { PUSH_PUZZLE_SPRITE_TAGS } from "./board";
export {
  PushPuzzleEngine,
  makePushPuzzleEngineLayer,
  // The genre's GameDefinition, which the README documents for an app that wires its own engine.
  makePushPuzzleGame,
  // The types of makePushPuzzleGame's argument and PushPuzzleEngine's value, so an app can name them.
  type PushPuzzleAssets,
  type PushPuzzleEngineLoader,
} from "./game";
export type { PushPuzzleSounds } from "./sound";
