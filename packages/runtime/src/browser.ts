// Runs a game in the browser: its presentation, the requestAnimationFrame driver over GameLoop,
// and the Effect engine.

export { GameDriver } from "./driver";
export { type GameEngine, makeGameEngine } from "./engine";
export { type FrameSource, animationFrames } from "./frames";
export {
  combineViews,
  type GameDefinition,
  type GamePresentation,
  type GameView,
} from "./presentation";
export type { GameSimulation, InputSource, StepInput } from "./simulation";
