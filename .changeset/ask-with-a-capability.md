---
"arcadekit": minor
---

A definition is plain data, and a system asks for what it needs with a capability: a function named for the access it gives, applied to the definition. `yield* Query.View(Moving)` gives a query's view, and `yield* Event.Emitter(Collided)` the handle that emits. There is one way to ask where there were three: a bare `yield*`, a getter such as `.emits`, and a function such as `World.writes`.

A capability costs a call, not a turn of the fiber's loop: about 25 ns where a yielded definition took about 210 ns. A tick of ten systems that do no work is about a fifth faster.

**Breaking**

A query, an event, a singleton, a state, a control, a bundle, a slot, a local and a setting are no longer Effects. Wrap each in its capability, where it is yielded and where it is passed as an Effect, as in `app.read(Singleton.Read(Score))`:

| Before                         | After                            |
| ------------------------------ | -------------------------------- |
| `yield* Moving`                | `yield* Query.View(Moving)`      |
| `yield* Query.removed(Sprite)` | `yield* Query.Removed(Sprite)`   |
| `yield* Collided`              | `yield* Event.Reader(Collided)`  |
| `yield* Collided.emits`        | `yield* Event.Emitter(Collided)` |
| `yield* Score`                 | `yield* Singleton.Read(Score)`   |
| `yield* Score.writes`          | `yield* Singleton.Write(Score)`  |
| `yield* Mode`                  | `yield* State.Reader(Mode)`      |
| `yield* Mode.sets`             | `yield* State.Setter(Mode)`      |
| `yield* Jump`                  | `yield* Input.Read(Jump)`        |
| `yield* Forest`                | `yield* Assets.Status(Forest)`   |
| `yield* Auto`                  | `yield* Save.Status(Auto)`       |
| `yield* Orbit`                 | `yield* System.Kept(Orbit)`      |
| `yield* Volume`                | `yield* Setting.get(Volume)`     |

- `asEffect()` is gone from each of them, and so is `pipe`, but for a query, which keeps `Query.all(...).pipe(Query.writes(Position))`. Pipe a setting with `pipe` from `"effect"`: `pipe(Keys, Setting.set(value))`.
- The class `Query.Removed` is gone. `Query.Removed(component)` is the capability, and takes the component.
- What a system requires is the same as before, so a stage refuses what it refused: a frame system that asks for `Event.Emitter`, `State.Setter`, `Singleton.Write` or the view of a query that writes doesn't compile.
- A lookup that throws, such as `Event.Emitter` outside the tick, throws at the line that asked, where a `try` around it catches it.
