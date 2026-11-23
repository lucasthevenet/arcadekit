---
"arcadekit": minor
---

A query that is put together wrong doesn't compile. `Query.writes` takes only the query's own terms, and a query that watches a component with `Query.changed` and writes it with `Query.writes` has no `eachChunk`. Both were refused at run time before, when the path ran. Each error names the component and says what to write instead.

**Breaking**

- `Query.all(Position).pipe(Query.writes(Velocity))` doesn't compile. Add `Velocity` to `Query.all`, or require it without its data with `Query.with(Velocity)`. A component the compiler knows only as a `ComponentDef` is still refused when it is given.
- `eachChunk` on a query made with `Query.changed(Position)` and `Query.writes(Position)` doesn't compile, in a frozen world too, where it was allowed before. Visit it with `each`, or leave `Position` out of `Query.writes` if the loop only reads it. A query description written by hand and passed to `world.view` is still refused when `eachChunk` runs.
