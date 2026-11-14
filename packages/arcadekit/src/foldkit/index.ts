// arcadekit/foldkit: a game's engine in a Foldkit app. The view renders the viewport (`Viewport`),
// the engine entry keeps the engine attached to it and turns its events into Messages
// (`EngineEntry`), and the app's own keys are Streams of Messages (`KeyPresses`, and
// `ShortcutPresses` for a key that works on any screen). Each module is a namespace. The view's
// part is plain, as Foldkit's `view` is; what runs the engine is Effect.

export * as EngineEntry from "./engine-entry";
export * as KeyPresses from "./key-presses";
export * as ShortcutPresses from "./shortcut-presses";
export * as Viewport from "./viewport";
