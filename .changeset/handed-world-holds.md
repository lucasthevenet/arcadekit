---
"arcadekit": minor
---

What a system, a handler or a setup is handed holds no call that compiles and then throws or does nothing. A relation's `target` is read-only in `each`, in `world.set` and in `World.writes(...).set`, so retargeting it there doesn't compile, where it threw. `Commands.spawn(ChildOf)` and `commands.add(entity, ChildOf)`, a relation with no target, don't compile, with an error that says to give it as `ChildOf.of({ target })`, and neither do they on a `CommandBuffer`. `world.sources(target, def)` takes only a relation, where any other component gave `[]`. A system or a handler that reads the event it emits hears it on its next run, when the entity its payload names is spawned, where it heard it at once, before that entity was there.

`RelationDef`, the type of any relation, is exported by `arcadekit` and `arcadekit/ecs`, and `arcadekit/ecs` exports `TargetField` and `PatchOf`, the fields `set` takes.

**Breaking**

- A system or a handler no longer reads, in the run that emits it, an event it emitted. It hears it on its next run, as a system listed ahead of the emitter does: for a tick system, on the next tick. Code that used the event at once uses the value it emitted instead.
- `row.target = x` in `each`, and `set(entity, Relation, { target })`, don't compile. Give the relation another target with `add(entity, Relation.of({ target }))`, on `Commands` or on the world.
- A relation given bare to `Commands.spawn`, `Commands.add`, `CommandBuffer.spawn` or `CommandBuffer.add` doesn't compile. Give it as `Relation.of({ target })`.
- `sources` takes a `RelationDef`. A list of relations typed `ComponentDef[]` is typed `RelationDef[]` to be given to it.
- `set` takes a `PatchOf<S>`, where it took a `Partial<ValueOf<S>>`.
