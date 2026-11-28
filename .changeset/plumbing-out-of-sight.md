---
"arcadekit": minor
"@arcadekit/three": minor
---

A module gives what a game uses and nothing else. What its own code needs is in `src/internal/`, so `State.`, `Save.`, `System.` and the rest offer only their public names, and what a system yields has no member a game must not call. The Oxlint rule `arcadekit/no-unused-internal` refuses an `@internal` member of a public export in the file of an entry. `arcadekit` gives the world's two types, `ReadingWorld` and `WritingWorld`, with the rest of `Services`, and a `Component` module of its own, `arcadekit/Component`, with `define`, `relation` and `tag`.

**Breaking**

- `State.defined`, `State.Registry`, `State.registryOf`, `State.handleOf`, `State.pending`, `State.enter`, `State.despawnScoped`, `State.refuseRemovedScopes` and `State.prepare` are gone from `State`, and so is a state's `scopes`. `State.scoped(state, value)` gives a value's tag.
- `Save.taking`, `Save.take`, `Save.versionOf`, `Save.into`, `Save.singleton`, `Save.VisitsData` and `Save.Visits`, `System.raw`, `System.triggered`, `System.spanLevel`, `System.unique` and `System.order`, `Action.said`, `Action.QueuedAction`, `Action.jsonOf` and `Action.Intake`, `Assets.fetching` and `Assets.fetchingFrom`, `Event.Emitted` and `Event.EventBus`, `Journal.Since` and `Journal.Log`, `Plugin.flatten`, `View.Intake`, and `Peer.Options`, `Peer.PeerApp` and `Peer.build` are gone. None of them was for a game.
- `Sound.PlayerShape` has no `_begin` and no `_flush`, and `Three.SceneShape` no `_kept` and no `_owned`. `Sound.plugin` and `Three.plugin` keep them to themselves.
- `import { EcsWorld, CommandBuffer, SnapshotError, readSnapshot, writeSnapshot } from "arcadekit"` is gone. A program of the storage core imports them from `arcadekit/ecs`: `import { World, CommandBuffer, SnapshotError, readSnapshot, writeSnapshot } from "arcadekit/ecs"`. The storage core's types stay in `arcadekit`.
- `Component` of `arcadekit` is the module `arcadekit/Component`, which has no `singleton`. A game defines a singleton with `Singleton.define(name, schema, initial)`. `Component.singleton` stays in `arcadekit/ecs`.
- `Browser.sound`, `Browser.stream`, `Browser.layerSound`, `Browser.AudioLike` and `Browser.MediaLike` are gone: they are `Audio.sound`, `Audio.stream`, `Audio.layerSound`, `Audio.AudioLike` and `Audio.MediaLike`, of `import { Audio } from "arcadekit/browser"`.
