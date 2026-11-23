---
"arcadekit": minor
---

A value a `json`, `ref`, `schema` or `transient` field holds reads as read-only all the way down, `Frozen<T>`, so it is replaced with `world.set` or by assigning the field in `each`, and never changed in place, which no change query would see and no refused action would undo. `Field.json<T>()` takes only a `T` that JSON holds, `JsonValue`: a `Date`, a `Map` or a class in it doesn't compile, where it came back from a save as something else.

**Breaking**

- `sheet.tags.push(tag)` on a field's array, or `profile.name = "x"` on a field's object, doesn't compile. Write `sheet.tags = [...sheet.tags, tag]`, or `world.set(entity, Sheet, { tags: [...] })`.
- `Field.json<T>()` with a `T` that isn't `JsonValue` doesn't compile: use `Field.schema` for a `Date` or a class.
- `Frozen` is in `arcadekit/ecs`, beside `JsonValue`. `Resource.Frozen` is the same type.
