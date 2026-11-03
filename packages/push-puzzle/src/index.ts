// Push-puzzle genre: content schema, content service and the simulation.
// No DOM or Three.js here; those are in "@gamekit/push-puzzle/browser".

export {
  CONTENT_FILES,
  PushPuzzleContent,
  makePushPuzzleContentLayer,
} from "./content";
export { LEVEL_CHARACTERS, Tile, parseLevel } from "./level";
export type { ParsedLevel } from "./level";
export { LevelDef, PuzzleContent, findLevelProblems } from "./schema";
export {
  type Direction,
  type HudSample,
  type Puzzle,
  type PushPuzzleConfig,
  type PushPuzzleEvent,
  type PushPuzzleInput,
  boardText,
  boxIdAt,
  boxesLeft,
  createPuzzle,
  hudSample,
  step,
} from "./world";
