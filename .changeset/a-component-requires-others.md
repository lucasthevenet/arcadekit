---
"arcadekit": minor
"@arcadekit/three": minor
---

A component can require others. `Component.define` and `Component.tag` take `requires`, and a spawn or an add fills in each required component the entity lacks, bare or with the value written there. `Commands.spawns` names what is filled in, so the order of systems sees it, and `RequiredOf` reads it in the type.

**Breaking**

- `Three.instances` refuses a kind whose `of` doesn't require the `Position` of its `transform`. An entity spawned without one was never drawn, and nothing said so. Before, `Component.tag("game/Rock")`; now, `Component.tag("game/Rock", { requires: [Transform3d.Position] })`.
- A replay recorded before a component required something spawns it without, and drifts from a game that fills it in. Record it again once the component requires others.
- `ComponentDef` takes a fourth type parameter and `ComponentValue` a third, the names a component requires. A `ComponentDef<S, St, N>` written out by hand reads as requiring any name, which `Commands.spawns` leaves out of the order check: write `ComponentDef<S, St, N, never>` for one that requires nothing.
