---
"arcadekit": patch
---

The doc comment of `Action.define` says that an action with no payload is issued with none, where it said `undefined`. The doc comment of `View.Bridge`'s `send` says that an action with no payload is sent with none, `ui.send(Start)`, and the module comment of `Browser` imports it as a game does, `import { Browser } from "arcadekit/browser"`. The doc comment of the world's `hash` names the singletons arcadekit keeps, which it covers, and what it leaves out. Nothing breaks.
