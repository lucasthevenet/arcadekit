---
"arcadekit": minor
---

The world keeps the app's own state the way it keeps a game's: as singletons. The queued actions and each event's waiting events, which were lists the world kept beside its singletons, are now singletons with a list field, and the lists are gone. A list field is added to in place, and a refused action's rollback takes out what its handler emitted and enqueued, where the app and the event bus each kept a mark to undo by hand. An app's singleton says whether a save holds it, whether the hash covers it, and whether the stages between ticks may write it; a game's singletons are saved, hashed, and refused between ticks, as before. `app.inspect()` shows the queued actions and the waiting events too, as plain data, under `arcadekit/Queued` and `arcadekit/events/<the event's name>`.

**Breaking**

- `ComponentDef.single` is the singleton's policy, `{ saved, hashed, betweenTicks }`, or undefined for a component, where it was a boolean.
- `FieldKind` has another kind, `"list"`, which `readSnapshot` shows in a snapshot's components and whose column holds each value encoded, as a `ref` field's does.
- `Event.EventMark` is gone, with the marks it named.
- `app.inspect().singletons` holds `arcadekit/Queued` and `arcadekit/events/<name>` while actions are queued or events wait.
- `app.events.emit()` throws while the world is frozen, in the frame stage and the input stage, as a system's `emit` there already did: an event emitted there is one no replay could repeat.
