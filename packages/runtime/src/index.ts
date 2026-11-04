// Steps a game anywhere: in a browser, a Web Worker, on a server, in a test.
// No DOM here; the browser driver, view and Effect engine are in "@gamekit/runtime/browser".

export { type FrameBudget, GameLoop } from "./loop";
export type { GameSimulation, InputSource, StepInput } from "./simulation";
