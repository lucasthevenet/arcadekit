---
"arcadekit": minor
---

A singleton whose every field holds an initial of its own, as a `Field.json`, `Field.schema` or `Field.ref` field does, can leave out its initial value, and starts at its fields' initials:

```ts
const Visited = Singleton.define("game/Visited", {
  rooms: Field.json<readonly string[]>(["hall"]),
});
```

A number field, a `Field.bool`, a `Field.entity` and a `Field.transient` hold none, and neither does a `Field.json` whose type takes `undefined`. Leaving the initial out of a singleton that has one of them doesn't compile, as before.

Nothing breaks.
