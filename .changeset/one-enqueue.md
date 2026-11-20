---
"arcadekit": minor
---

`app.enqueue` and `Actions.enqueue` are one function, and where it is called decides whether the action is logged. From a tick, a handler, a script or a plugin's setup it is the simulation's own move and isn't logged; between ticks, the frame and input stages included, it is input and is logged. A system or a handler that holds the app and calls `app.enqueue` no longer logs its move, which a replay applied twice. `app.enqueueByName` follows the same rule.

**Breaking**

- `app.enqueue` and `app.enqueueByName` called during a tick or from a handler no longer log the action, and don't send it to the other peers of a session: every peer's simulation issues it. `app.enqueue` returns `Exit.void` there without checking the payload against the schema, as `Actions.enqueue` always did.
- `app.enqueueByName` with an issuer, `from`, throws when called by the simulation.
