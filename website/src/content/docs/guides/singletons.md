---
title: "Singletons"
description: "A singleton is data that exists once per world, such as the score. Learn how to define one, read and write it, and how saves treat it."
---

A **singleton** is data that exists once per world, such as the score, whose turn it is, or the current level. Its fields are [component fields](components.md#choose-a-field-type), of the same types, and the third argument of `Singleton.define` is its initial value. `yield* Singleton.Read(Score)` gives you the world's value to read. `yield* Singleton.Write(Score)` gives the same value with fields you can assign. Only the simulation can ask for it: a system of the tick, an action handler or a plugin's `setup`.

```ts
import { Field, Plugin, Singleton, System } from "arcadekit";

const Score = Singleton.define(
  "game/Score",
  { points: Field.i32 },
  { points: 0 }
);

const Bonus = System.tick("game/Bonus", function* () {
  const score = yield* Singleton.Write(Score);
  score.points += 1;
});

const Rules = Plugin.make("game/Rules", {
  systems: [Bonus],
});
```

A singleton whose every field holds an initial of its own, as a `Field.json`, `Field.schema` or `Field.ref` field does, can leave out the third argument. It then starts at its fields' initials:

```ts
import { Field, Singleton } from "arcadekit";

const Visited = Singleton.define("game/Visited", {
  rooms: Field.json<readonly string[]>(["hall"]),
});
```

A number field, a `bool`, an `entity` and a `transient` field hold no initial of their own, and neither does a `json` field whose type takes `undefined`. A singleton with any of them gives its initial value, or it doesn't compile.

A singleton lives in the world, so it is saved, hashed, and restored when an action is refused.

- Until it is first written, it holds its initial value and is neither saved nor hashed. Reading it changes nothing, so a plugin that only reads a singleton doesn't change the hash of the game it observes.
- Loading a save in which a singleton was never written gives it the initial value of the build that loads it.
- Its name is one of the world's component names, and a save finds it by that name. To rename or change it, write a [migration](migrating-saves.md) with `Migrate`, as for a component.
- No entity can have it, and no query visits it. Spawning or adding it throws.

A [`Resource`](plugins.md#configure-a-plugin-with-a-resource) is the other kind of single value. It is configuration with a default that a layer can override, such as gravity. It isn't game state, and isn't saved.

## Read more

- [`Singleton`](/reference/arcadekit/Singleton) in the API reference.
