---
"arcadekit": minor
---

An action declares its refusals in `Action.define(name, payload, { refusals })`, each a class made with `Schema.TaggedError`, and `Action.rejected(action)` reads the refusals of one action with its payload and error typed, the same on every peer and across a save.

**Breaking**

- A handler fails only with the refusals its action declares. A handler that failed with a `Data.TaggedError`, a string or any other error no longer compiles: make the error a `Schema.TaggedError` and list it in its action's `refusals`. An action with no payload and refusals takes `Schema.Void` as its payload.
- `Action.Rejected`'s `error` is the refusal in its JSON form, `{ _tag, ...its fields }`, where it was `{ _tag, message }`. It has a `message` only when the error's class declares one.
- A queued action whose handler dies, is interrupted, or fails with an error its action doesn't declare no longer becomes an `Action.Rejected`: what it did is undone, and the tick fails, so `app.tick` throws, as it does for a system that fails.
- `Action.InvalidPayload` and `Action.UnknownAction` are `Schema.TaggedError` classes, with the same fields.
- `Action.ActionDef` has a third type parameter, the refusals, and the fields `refusals` and `rejected`. An action is made with `Action.define`.
