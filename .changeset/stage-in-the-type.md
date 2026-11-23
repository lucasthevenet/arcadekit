---
"arcadekit": minor
"@arcadekit/three": minor
---

A system's stage is in its type. `System.tick`, `System.frame` and `System.input` refuse a body that uses the other stages, and `App.define` and `Plugin.make` refuse two systems, handlers or plugins that share a name.

**Breaking**:

- `System.make` is removed. A system of the tick is `System.tick`, one that draws or plays is `System.frame`, and one that reads the devices is `System.input`.
- `System.inStage` only moves a system inside the group it was made in: `"preUpdate"` and `"postUpdate"` for a tick, `"preFrame"` and `"postFrame"` for a frame. The input stage is `System.input`.
- `State.onEnter` and `State.onExit` are `State.onEnter(state, value, name, body)` and `State.onExit(state, value, name, body)`. They are not pipes.
- Emitting is `yield* Event.emits`, setting a state is `yield* State.sets`, and writing a singleton is `yield* Singleton.writes`. `yield*` on the definition reads. A frame or input system cannot require those.
- `Sound.Player` and `View.Port` cannot be required by a tick system or an input system. `Input.Devices`, `Frame`, `View.Intake` and `Assets.Store` cannot be required by a tick system.
- `Action.handler` and a plugin's `setup` take what a tick system takes. `System.runIf` and `System.otherwise` take what the system's stage takes.
- A tuple of systems, handlers or plugins with one name twice does not compile. A list that is not a tuple is still refused when the app is made.
