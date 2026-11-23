---
"arcadekit": minor
---

An app has a scope of its own, and `app.close` closes it. `App.make` requires no `Scope`: it builds the plugins' layers, listens to the devices and opens the sound in its own scope, which lasts until the app is closed, and is closed at once when the making fails. An app made in a scope that has since closed, as `Effect.runSync(Effect.scoped(App.make(game)))` makes one, still hears the page's devices and plays its sound; before, its devices threw and its sound played nothing, with no error. `Driver.run` closes the app it runs when it ends, is interrupted, or a tick throws. `Transport.connect` listens in a scope of its own too: the connection has `close`, which stops listening and closes the session it connected. After `close`, a page's devices, its sound and a transport of the package each throw when used, and say that what opened them was closed; a page's sound used to play nothing.

What breaks:

- `App.make`, `Session.make`, `Session.syncTest`, `Journal.replay` and `Transport.connect` require no `Scope`, and closing the scope a program ran them in no longer lets go of what they opened. A program that makes an app itself and runs it with `Driver.frames` closes it when done, as with `Effect.acquireRelease(App.make(game), (app) => app.close)`. `Driver.run` needs nothing: it closes what it made.
- `Driver.run` takes an effect that makes something with `close`: an app, a session, or a connection made by `Transport.connect`. A step of that effect that can fail after the app is made holds the app with `Effect.acquireRelease`, so that it is closed when the step fails.
- `Transport.connect(session)` takes the session's `close`, and its connection's `close` closes the session.
- A session's app, `App.Steered`, has no `close`: `session.close` and `test.close` of `Session.syncTest` close it.
- The app a `Journal.ReplayDiverged` holds has been closed by the replay: read it, and do not close it.
- A frame or input system that requires a `Scope` is given the app's, and `App.make` no longer requires one for it.
- `Browser.layerSound`'s speaker, and so `Sound.open` under `Browser.layer`, throws when played after it was let go, where it played nothing. The messages of the devices and of `Transport.layerBroadcastChannel` and `Transport.layerWebSocket` used after they were let go say so in other words.
