---
"arcadekit": minor
---

A system says what it spawns and what it sets where it asks for the thing that does it, so the compiler knows, and the order of a list of systems is checked for those too. A system that watches a component with `Query.added` or `Query.changed`, listed ahead of a system that spawns it, adds it or sets it with `world.set`, reacted a tick late with no error: a spawn and a `world.set` were plain calls that nothing in a system's type recorded. Now that list doesn't compile, as one with a watcher ahead of a query that writes already didn't.

- `yield* Commands.spawns(Bullet, Position)` gives commands that spawn and add those components. Another component doesn't compile, and the error says where to name it. `yield* Commands` gives commands that despawn and remove.
- `yield* World.writes(Health)` gives a world that sets that component. `yield* World` gives one that reads.
- The world a system, a handler or a plugin's `setup` is handed reads an entity and a singleton, and no longer has `spawn`, `despawn`, `add`, `remove`, `view`, `random`, or what an app does with its world, such as `restore` and `freeze`. The set of entities changes through `Commands` alone. `app.world` is the whole world, as before.

`Query.removed` isn't checked: a despawn doesn't say which components its entity had. Its doc comment says so.

**Breaking**:

```ts
// Before
const Shoot = System.make("Shoot", function* () {
  const commands = yield* Commands;
  commands.spawn(Bullet, Position.of({ x: 0, y: 0 }));
});
const strike = Action.handler(Strike, function* ({ target }) {
  const world = yield* World;
  world.set(target, Health, { hp: 3 });
});

// Now
const Shoot = System.make("Shoot", function* () {
  const commands = yield* Commands.spawns(Bullet, Position);
  commands.spawn(Bullet, Position.of({ x: 0, y: 0 }));
});
const strike = Action.handler(Strike, function* ({ target }) {
  const world = yield* World.writes(Health);
  world.set(target, Health, { hp: 3 });
});
```

- A query is asked for with `yield*`, and no longer taken from a yielded world with `world.view(query)`.
- `Commands` gives a `Spawning`, and no longer the `CommandBuffer` with its `apply`: commands are applied when the system finishes.
- `ComponentValue` has a second type parameter, the component's name, and `Query.Query`'s second is now what it watches, as `Query.Watches` and `Query.WatchesAdded`.
- A list with a system that watches ahead of one that spawns, adds or sets what it watches no longer compiles.
