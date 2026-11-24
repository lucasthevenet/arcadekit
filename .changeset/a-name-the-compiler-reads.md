---
"arcadekit": minor
---

A component's name is a literal the compiler reads, and only `Query` makes the description `world.view` takes. A name known only as `string` and a query description written by hand both compile no more, where each was refused at run time, if at all.

**Breaking**

- `Component.define`, `Component.tag` and `Component.relation` take a name the compiler reads: `Component.define("game/Hero", schema)`, or a template such as `` `game/Tag${n}` ``. A name typed `string` doesn't compile, and the error says to write a literal.
- `world.view` takes only a `Query`. An object written as `{ terms, withDefs, withoutDefs }` doesn't compile: write `Query.all(...terms).pipe(Query.without(...), Query.writes(...))`. `QuerySpec` stays exported, as the type of what `world.view` takes.
- `world.view` no longer checks that `readDefs` are among the terms, since `Query` makes them from its terms.
