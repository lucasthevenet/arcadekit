---
"arcadekit": minor
---

`Driver.run` takes a `ready` step, `Driver.run(App.make(game), { hz: 60, ready: (app) => ... })`, which runs with the app before its first frame. The run holds the app before `ready` runs, so it closes the app when `ready` fails, and fails with what `ready` failed with. A step tapped onto `App.make` that failed left the app open, with the page's devices and sound, unless the program held it with `Effect.acquireRelease`. `Driver.Ready` is the option's type.

Nothing breaks. A step tapped onto the effect that makes the app still runs, and still leaves the app open when it fails: give it as `ready` instead.
