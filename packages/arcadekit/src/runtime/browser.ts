// Runs a game in the browser: its presentation, and the Effect engine that steps and draws it
// on requestAnimationFrame.

export {
  AttachError,
  attachError,
  type EngineLoader,
  type GameEngine,
  type LoadedEngine,
  engineOf,
  makeEngineLoader,
  makeGameEngine,
} from "./engine";
export {
  GameCrashed,
  type SteppedLoop,
  frameLoop,
  steppedFrames,
} from "./frame-loop";
export { type FrameSource, animationFrames } from "./frames";
export {
  combineViews,
  type GameDefinition,
  type GamePresentation,
  type GameView,
} from "./presentation";
export type { GameSimulation, InputSource, StepInput } from "./simulation";
