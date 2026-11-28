---
"arcadekit": minor
---

The view bridge's `send` refuses a payload its action's schema does not take where it is called, as `app.enqueue` does, where the next input stage threw and stopped the game.

**Breaking**

- `ui.send` returns `Exit<void, Action.InvalidPayload>`, which fails, with nothing issued or logged, for a payload the schema refuses. A page that ignores it compiles and runs as before; one that shows the refusal reads the `Exit`.
- A `View.Bridge` written by hand, such as a stand-in in a test, returns an `Exit` from `send`.
