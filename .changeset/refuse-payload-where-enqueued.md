---
"arcadekit": minor
---

`app.enqueue` refuses a payload its action's schema does not take where it is called, in a game of one and of several peers alike, where it queued it to be refused when its turn came, on the issuing peer alone.

**Breaking**

- `app.enqueue` returns `Exit<void, Action.InvalidPayload>`, which fails, with nothing queued or logged, for a payload the schema refuses. Such a payload used to become an `Action.Rejected` event at the start of the next tick; a game that showed that refusal reads the `Exit` instead.
- A system of the frame or input stage that issues such a payload with `Actions.enqueue`, as an input binding does, throws.
