---
"arcadekit": minor
---

A `json`, `ref` or `schema` field is made with its initial value, `Field.json<string>("")`, `Field.ref(codec, initial)` and `Field.schema(schema, initial)`, and a component spawned or added bare holds it there. A bare component read `undefined` in such a field while its type said `T`, and a bare `ref` or `schema` field made the hash throw and the snapshot refuse. `Grid.tiles(width, height)` holds a map of every tile 0 in a bare component.

**Breaking**

- `Field.json<T>()`, `Field.ref(codec)` and `Field.schema(schema)` with no initial value don't compile. Write `Field.json<string>("")`, `Field.ref(codec, value)` and `Field.schema(Schema.Date, new Date(0))`. A singleton's fields are given one too, though the singleton's own `initial` is what it holds.
- A component with such a field and no `initial` of its own has a `ComponentDef.initial` made of its fields' initial values, where it was undefined. A singleton's `ComponentDef.initial` is the singleton's initial value.
