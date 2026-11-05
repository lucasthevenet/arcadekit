// Connects a @arcadekit/runtime engine to a Foldkit app: `gameViewport` renders the element the
// engine draws into, and `engineEntry` runs the engine there and turns its events into
// Messages. `keyPresses` is for an app's own keys (pause, restart), and `shortcutPresses` for
// one that works on any screen (mute).
export {
  type AttachableEngine,
  engineEntry,
  gameViewport,
  type EngineEntryConfig,
  type GameViewportMessages,
} from "./viewport";
export { keyPresses, shortcutPresses } from "./keys";
