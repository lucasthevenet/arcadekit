---
"arcadekit": patch
---

The doc comment of `Action.define` says that an action with no payload is issued with none, where it said `undefined`. The doc comment of `View.Bridge`'s `send` says that an action with no payload is sent with none, `ui.send(Start)`, and the module comment of `Browser` imports it as a game does, `import { Browser } from "arcadekit/browser"`. Nothing breaks.
