---
"arcadekit": minor
---

A query's view reads the one entity a game has with `single()`, which hands out its accessors and its id as `each` would, and throws, naming the query and how many it matched, when that is not one:

```ts
const Players = Query.all(Position).pipe(Query.with(Player));
const Look = System.tick("game/Look", function* () {
  const [position, player] = (yield* Players).single();
});
```

A plain function typed for what it writes takes the world, the commands and a singleton of any system that writes those and more: `WritingWorld<"game/Health">` takes `yield* World.writes(Health, Position)`, `Spawning<"game/Spark">` takes `yield* Commands.spawns(Spark, Position)`, and `Singleton.Write<typeof Score>` is what `yield* Score.writes` gives. The systems guide shows one, and the queries guide lists a view's members.

**Breaking**

- A tag is not a term of `Query.all`, since it has no data: the loop was handed an empty row in its place. `Query.all(Position, Player)` doesn't compile, and throws for a tag the compiler knows only as a `ComponentDef`. Write `Query.all(Position).pipe(Query.with(Player))`, and drop the tag's argument from the loop, or take it as `Query.maybe(Player)` to be told whether an entity has it.
- A world or commands that write less no longer pass for ones that write more: a function typed `WritingWorld<"game/Health" | "game/Position">` refuses `yield* World.writes(Health)`, which it took before. Ask the world for every component the function sets.
