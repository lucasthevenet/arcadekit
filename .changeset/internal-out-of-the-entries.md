---
"arcadekit": minor
"@arcadekit/three": minor
---

What only the package's own modules use is out of the entries, in files of `internal/` behind them, and the types that a public signature names are documented exports. The Oxlint rule `arcadekit/no-internal-in-entries` keeps it so.

What breaks: no game used these, but each was importable, and none is any more.

- `arcadekit/Action`: `said`, `jsonOf`, `Intake` and `QueuedAction`.
- `arcadekit/Assets`: `fetching` and `fetchingFrom`.
- `arcadekit/Event`: `Emitted`.
- `arcadekit/Journal`: `Log` and `Since`.
- `arcadekit/Plugin`: `flatten`.
- `arcadekit/Save`: `taking`, `take`, `versionOf`, `into`, `singleton`, `VisitsData` and `Visits`.
- `arcadekit/State`: `defined`, `Registry`, `registryOf`, `handleOf`, `pending`, `enter`, `despawnScoped`, `refuseRemovedScopes` and `prepare`.
- `arcadekit/System`: `raw`, `triggered`, `spanLevel`, `unique` and `order`.
- `arcadekit/View`: `Intake`.
- `arcadekit/net/Peer`: `Options`, `PeerApp` and `build`.

What is now on the reference, as it was already in the signatures: `App.Systems`, `App.Handlers`, `App.Plugins`, `App.TickError`, `App.AllHandlers` and `App.External`; `Plugin.Clashes`; `System.TickGated`, `System.TickBody`, `System.FrameOk`, `System.FrameBody`, `System.TickEffect`, `System.LayerGated`, `System.Listing` and `System.Ordered`. `@arcadekit/three/Three` adds `Three.Entries`, the assets of a bundle a look is built `from`, and `Three.Needs`, what its drawing systems require, which `Three.instances` and `Three.objects` named and a game could not.
