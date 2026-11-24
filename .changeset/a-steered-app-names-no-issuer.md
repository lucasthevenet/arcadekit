---
"arcadekit": minor
---

`App.Steered`'s `enqueueByName` takes a name and a payload, and no `from`. A session stamps each action with the name of the peer that issued it, so passing `from` on `session.app` doesn't compile, where it threw.

What breaks: a call to `session.app.enqueueByName(name, payload, from)` with a `from` no longer compiles. That call already threw at run time. Drop `from`, and the session names this peer as the issuer.
