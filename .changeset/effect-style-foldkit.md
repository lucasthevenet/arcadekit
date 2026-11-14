---
"arcadekit": minor
---

`arcadekit/foldkit` is written as Effect's modules are ([ADR-0024](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0024-the-kit-is-written-as-effect-modules.md)): its modules are four namespaces, `Viewport`, `EngineEntry`, `KeyPresses` and `ShortcutPresses`, each with a `make`, and every export has Effect's doc comment, with an example that runs. **Breaking**: every export of `arcadekit/foldkit` is renamed.

What an app sees besides the names:

- **The viewport and the engine entry work as they did.** `Viewport.make` renders the same `div.viewport`, whose Mount is still named `"GameViewport"`, so a Scene test resolves it as before. `EngineEntry.make` takes the same config (`engine`, `isViewportMounted`, `toMessage`, `onError`, required exactly when the engine can fail), attaches one engine at a time, and sends `onError`'s Message once. A viewport missing from the document still dies; its message now names `Viewport.make`.
- **Key presses are Effect's own Stream of a DOM event.** `KeyPresses.make` and `ShortcutPresses.make` are `Stream.fromEventListener` on the window's `keydown`, and report the same presses: no auto-repeat, and for a shortcut no Ctrl, Cmd or Alt and no text field. The window is read when the Stream runs, so an app may make one as its module loads (`Subscription.persistentEntry(ShortcutPresses.make(["KeyM"], ...))`) where a test in Node has no window.
- **`toMessage` is given the code as one of the keys listed.** `KeyPresses.make(["KeyR", "Escape"], (code) => ...)` types `code` as `"KeyR" | "Escape"`, so comparing it with a key that isn't listed is a type error.

```ts
import {
  EngineEntry,
  KeyPresses,
  ShortcutPresses,
  Viewport,
} from "arcadekit/foldkit";

// Before: gameViewport(h, { mounted, unmounted })
Viewport.make(h, { mounted, unmounted });

// Before: engineEntry({ engine: RaceEngine, isViewportMounted, toMessage, onError })
EngineEntry.make({ engine: RaceEngine, isViewportMounted, toMessage, onError });

// Before: keyPresses(["KeyR"], toMessage) and shortcutPresses(["KeyM"], toMessage)
KeyPresses.make(["KeyR"], toMessage);
ShortcutPresses.make(["KeyM"], toMessage);
```

**Breaking**

Every export of `arcadekit/foldkit` before, and what an app writes now:

| Before | Now |
| --- | --- |
| `gameViewport(h, messages)` | `Viewport.make(h, messages)` |
| `GameViewportMessages<Message>` | `Viewport.Messages<Message>` |
| `engineEntry(config)` | `EngineEntry.make(config)` |
| `EngineEntryConfig<Model, Message, Event, R, E, A>` | `EngineEntry.Config<Model, Message, Event, R, E, A>` |
| `AttachableEngine<Event, E>` | `EngineEntry.Attachable<Event, E>` |
| what `engineEntry` returned, Foldkit's `Subscription.EntryWithoutKeepAlive<…>` | the same type, named `EngineEntry.EngineEntry<Model, Message, R>` |
| `keyPresses(codes, toMessage)` | `KeyPresses.make(codes, toMessage)` |
| `shortcutPresses(codes, toMessage)` | `ShortcutPresses.make(codes, toMessage)` |
