---
"arcadekit": minor
---

A state's name is a literal the compiler reads, as a component's is, so `State.scoped(Phase, "playing")` is typed by the name it has, `"game/Phase.Scoped.playing"`. `Commands.spawns` named with one state's scope no longer lets a system spawn the scope of another state's value of the same name, or of another value of the same state, and the order of a list of systems is checked against the scope a system spawns, not that value of every state.

**Breaking**

- `State.define` takes a name the compiler reads: `State.define("game/Phase", values)`. A name typed `string` doesn't compile, and the error says to write a literal.
- `State` takes its name as a second type parameter, `State<V, N>`, which defaults to `string`.
- `State.scoped` returns a tag typed ``ComponentDef<{}, "table", `${N}.Scoped.${S}`>``, for the state's name `N` and the value `S` it is given, where it was named `` `${string}.Scoped.${V}` `` for every value `V` of the state. A system that spawns two values' scopes names each in `Commands.spawns`.
