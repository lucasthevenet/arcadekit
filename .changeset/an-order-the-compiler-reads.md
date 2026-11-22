---
"arcadekit": minor
"@arcadekit/three": patch
---

A list of systems in which one would react a tick late to another doesn't compile. A system that watches a component with `Query.changed`, listed ahead of a system that writes it in the same tick, saw the write on the next tick, with no error. Now `App.define` and `Plugin.make` refuse that list, and the error names the two systems and says which to list after the other.

Nothing is declared. Yielding a query puts what it writes and watches in the requirements, as `Query.Writes<"game/Position">` and `Query.Watches<"game/Position">`, so a system's type says it, through a branch, a condition or another Effect alike. The app provides them, since they stand for nothing at run time. The check follows the order a tick runs: stage by stage, a plugin's dependencies before the plugin, plugins before the app's own. Hooks, handlers, and the frame and input stages run at another moment and are left out.

**Breaking**:

- A list with a watcher ahead of its writer no longer compiles. List the watcher after the writer, or place it in a later stage.
- `System.System` has three more type parameters, for the system's name, its stage and what triggers it: `System<E, R, N, St, Tr>`. `System.System<E, R>` is still any system of that error and those requirements. A function's `ReturnType` that was used as the type of any system now names one system: write `System.System<E, R>`.
- `Query.Query` has a second type parameter, the names of the components it watches, and yielding a query requires `Query.Needs<D, W>` where it required `World`. `Plugin.Plugin` has a seventh, its systems in order.
- A query that writes or watches can't be yielded outside an app by providing `World` alone. Code outside the simulation reads it from the world:

```ts
// Before
const moved = yield * Moved.pipe(Effect.provideService(World, app.world));

// Now
const moved = app.world.view(Moved);
```

`@arcadekit/three` draws as before: the types of its queries say that they only read.
