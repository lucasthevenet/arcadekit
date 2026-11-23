---
"arcadekit": minor
---

`Transport.layerBroadcastChannel` tells the other peers who joined and who left, as a relay does. It posts a `Message.Notice` that its peer joined when its channel opens, and one that it left when its channel closes. `Browser.runMain` closes the channel when the page is closed for good. So `connected.away` lists a tab that closed, where it stayed empty before.

**Breaking**

- `Transport.layerBroadcastChannel(name)` is `Transport.layerBroadcastChannel(name, me)`, with the peer's name as its session has it.
- Every peer that listens on the same name hears a `{ joined }` and a `{ left }` notice from the others, beside their messages.
