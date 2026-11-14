# arcadekit/foldkit

Connects a game's engine ([`Game.Engine`](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/engine.md)) to a [Foldkit](https://www.npmjs.com/package/foldkit) app. The view renders the viewport with `Viewport.make`: the element the engine draws into, which reports two Messages as it enters and leaves the document. The Subscription entry `EngineEntry.make` runs the engine there while it is in the document, and turns the engine's events into Messages. `KeyPresses.make` and `ShortcutPresses.make` make Streams of the app's own keys as Messages: pause, restart, mute. Each is a namespace, as Effect's modules are.

An entry of the [`arcadekit`](../../README.md) package. Needs the DOM.

## Install

```bash
pnpm add arcadekit foldkit effect @effect/platform-browser
```

Peer dependencies: `effect` (~4.1), and `foldkit` (~0.170, an optional peer of the package that this entry needs). Foldkit itself needs `@effect/platform-browser`.

## Its modules

Each is a namespace, as Effect's modules are.

| Namespace | What it holds | Guide |
| --- | --- | --- |
| `Viewport` | The element an engine draws a run into, which reports two Messages as it enters and leaves the document | [A Foldkit app](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/foldkit.md) |
| `EngineEntry` | The Subscription entry that runs an engine in the viewport and turns its events into Messages | [A Foldkit app](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/foldkit.md) |
| `KeyPresses` | A Stream of the app's own keys on one screen, as Messages | [A Foldkit app](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/foldkit.md#the-apps-own-keys) |
| `ShortcutPresses` | A Stream of a key that works on any screen, such as M to mute | [A Foldkit app](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/foldkit.md#the-apps-own-keys) |

## Example

M mutes on every screen:

```ts
import { ShortcutPresses } from "arcadekit/foldkit";
import { Subscription } from "foldkit";
import { defineMessageUnion } from "foldkit/message";

const Message = defineMessageUnion({ PressedMute: {} });
type Message = typeof Message.Type;

interface Model {
  readonly muted: boolean;
}

export const subscriptions = Subscription.make<Model, Message>()(() => ({
  muteKey: Subscription.persistentEntry(
    ShortcutPresses.make(["KeyM"], () => Message.PressedMute())
  ),
}));
```
