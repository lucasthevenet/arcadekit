---
"arcadekit": minor
---

A save's waiting events are decoded with their schemas as it is loaded, and a save that holds one in a form its schema no longer takes is refused with `"event changed"`, where the event threw when a system first read it. For that, a plugin lists the events a save may hold in `events`, as it lists components, and the app takes `events` too.

**Breaking**

- An event that may be waiting to be read when the game is saved is listed in a plugin's `events`, or the app's: `Plugin.make("Combat", { components: [Health], events: [Struck] })`. Saving while an unlisted event is waiting fails with `Save.SaveRefused`, and loading a save that holds one fails with `Save.LoadRefused`, problem `"unknown event"`.
- Listing an event defined with a type and no schema throws when the app is made.
- `Save.LoadRefused`'s `problem` has two more values, `"unknown event"` and `"event changed"`.
- `Event.EventsMoment` has no `parked`: no event of a save waits for its definition any more.
