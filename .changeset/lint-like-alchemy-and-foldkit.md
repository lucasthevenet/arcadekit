---
"arcadekit": minor
"@arcadekit/three": minor
---

No export takes or returns `any`. What stands for any component, singleton, event, state, system, plugin, action or handler says what it is: `ComponentDef`, `SingletonSpec`, `EventDef<unknown>`, `State<string>`, `System<unknown, unknown>`, `Plugin.Any` (of `unknown`s), and the new `Action.AnyActionDef` and `Action.AnyHandler`, whose payload is `never`. `System.GenError` and `System.GenServices` are new: what a generator's effects fail with and need, as `Effect.gen` says it, which `System.make`, `Sound.music` and `View.publish` now return. `Driver.interval` beats on Effect's `Clock`, so a `TestClock` moves it on.

**Breaking**

- `Migrate.mapField`'s `map` names the type of the old value: `(hp: number) => hp / 2`, where `(hp) => hp / 2` took it as `any`.
- A list typed as `Plugin.AnySystem[]` or `Plugin.AnyHandler[]` and given to `App.make` makes the app need `unknown`, where `any` let it run. Type the list with what its systems need, `System.System<never, World | Time>[]`, or pass the systems themselves.
- `ComponentDef.of`, `EventHandle.emit`, `StateHandle.is` and `StateHandle.set` are typed as methods, so that a component, an event or a state of any type is one of the types above. They work as before; a game that lints with `typescript/unbound-method` is told about one taken off its object.
- `Sound.cues`, `Three.instances` and `Three.objects` are overloaded functions, with the same two signatures each.
- `Three.ColorComponent`'s `r`, `g` and `b` are `FieldDef<number, unknown>`.
