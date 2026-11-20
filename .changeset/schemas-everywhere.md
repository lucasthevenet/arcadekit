---
"arcadekit": minor
---

Every action and every event has a schema, so each one can be logged, saved, replayed and sent to the other peers of a session, and none fails at run time for lack of one. An action or event with no payload takes only its name: `Action.define("Pass")`, `Event.define("Started")`. `Action.Rejected` has a schema too: its payload is in its JSON form, and its error is the error's `_tag` and `message`. An action with no payload was logged with `undefined`, which a log written as text dropped and could not read back; it is logged with `null`.

**Breaking**

- `Action.define<Payload>()("Name")` and `Event.define<Payload>("Name")` are gone. Write `Action.define("Name", schema)` and `Event.define("Name", schema)`, or only the name for no payload.
- `ActionDef` takes two type parameters, `ActionDef<N, P>`, where it took a third for the validation error. A handler's failures always include `Action.InvalidPayload`.
- `Action.Rejected`'s `error` is `{ _tag, message }`, not the error itself, and its `payload` is the JSON form. A system that matched on the error's class matches on `error._tag`.
- `ActionDef.codec` and `EventDef.codec` are never `undefined`.
