# Roadmap

What to build next, in order, and why in that order. The package's [README](../packages/arcadekit/README.md) says what exists today; [conventions](./conventions.md) says how to write what comes next.

Each item says what it is for, what has to be true for it to be done, and what it depends on. An item is not done until it has tests that fail when it is broken, and an entry in the README.

The order follows one rule: build what later items stand on first. Saving needs a seeded random source; netcode needs saving; a renderer needs a frame loop. Within a milestone the items are in order too.

## 0. Housekeeping

Small, and worth doing before anything is built on top.

- **Move to TypeScript 7.1 when it is released.** The declaration build prints a deprecation warning on 7.0. Done when `pnpm build` is quiet.

## 1. Determinism you can rely on

Done. A seeded random service, a hash of the world, replays that check themselves against it, handlers that run in a transaction, and a log that holds what came from outside the simulation. The package's [README](../packages/arcadekit/README.md) describes each. Saving and netcode stand on these.

## 2. Saving and loading

Done. A world is saved as a snapshot and loaded back, every field says what saving does with it, a game is saved and loaded with what was waiting in it, and a save of an older version is migrated or refused with the reason. The package's [README](../packages/arcadekit/README.md) describes each.

## 3. What every game ends up needing

Each of these is something a game would otherwise build badly for itself.

Done so far: change detection (`Query.changed`, `Query.added`, `Query.removed`), with writes noticed per row; singletons (`Singleton.define`), which are the world's and saved with it; relations (`Component.relation`), whose holders go with a despawned target or lose the relation; and states with run conditions (`State.define`, `System.runIf`, `State.onEnter`, `State.onExit`). The package's [README](../packages/arcadekit/README.md) describes each.

- **Simulation and presentation as separate stages.** The simulation ticks at a fixed rate; drawing happens every frame, between ticks, and must not change the world. Done when `App` runs a fixed-rate stage and a per-frame stage, and the per-frame stage gets how far it is between two ticks.

## 4. Running in a browser

Nothing so far draws, plays sound or reads input.

- **A frame loop driver.** `requestAnimationFrame` wrapped with `Effect.callback`, feeding the fixed-step driver, stopping cleanly when interrupted, pausing when the tab is hidden. Done when a game runs in a page and closing the app's scope leaves nothing running.
- **Input.** Keyboard, pointer and gamepad state read once per tick into the world, so the simulation sees one consistent picture; and a mapping from input to actions. Done when input goes through the same action log as everything else, so a replay needs no input at all.
- **Assets.** Loading as a scoped resource: a level's assets are acquired when it starts and released when its scope closes. Done when leaving a level frees what it loaded, with a test that proves it.
- **An entry point.** `BrowserRuntime.runMain` around `App.make` and a driver, as the one obvious way to start a game. Done when the examples use it.

Depends on the two stages from milestone 3.

## 5. Drawing and UI

The package's stated aim is games on Effect, Foldkit and Three.js. These are plugins, not part of the core: a game that draws with something else leaves them out.

- **A Three.js plugin.** Components for what is drawn, and a per-frame system that copies positions from columns to the scene. Instanced meshes read a column directly. Done when ten thousand moving objects draw without one allocation per object per frame.
- **A Foldkit bridge.** UI reads the world through events and a few selected values, and acts on it only by dispatching actions. Done when a menu and a heads-up display are built without the UI holding a reference to the world.
- **Sound.** A service that plays a named cue, driven by events. Done when the simulation never calls it directly.

Decide before starting whether each of these is an entry of `arcadekit` or a package of its own.

## 6. More than one player

- **Lockstep.** Every peer runs the same simulation and exchanges only actions, each stamped with the tick it applies on. The action log is already most of this. Done when two apps in one test, joined by a fake network with delay and reordering, stay hash-equal.
- **Drift detection.** Peers compare hashes and stop with a useful report when they differ. Done when a deliberately non-deterministic system is caught within a known number of ticks.
- **Rollback.** Predict, and when a late action arrives, restore a snapshot and re-run. Done when a game feels immediate under simulated latency and still ends hash-equal.
- **A transport.** A service with a test implementation first, a real one second.

Depends on milestones 1 and 2 entirely.

## 7. Speed and scale

Only with a benchmark that shows the need.

- **Accessors without code generation.** `each` builds its accessors with `new Function`, which a strict Content Security Policy forbids, and the obvious fallback measured about forty times slower than raw columns. Done when the package works under such a policy at a cost a game can accept.
- **Benchmarks in CI.** Done when a change that slows the storage core by more than the noise fails a check.
- **Systems that declare what they read and write.** The first step towards running systems in parallel, and useful on its own for ordering and for tools. Done when the order of systems can be checked for conflicts.
- **Parallel systems.** Workers over shared memory, for systems whose declared access does not overlap. Done when it is faster on a real workload, and still deterministic.
- **Wider entity ids.** A handle is 22 bits of index and 10 of generation; a slot reused 1,024 times can alias an old handle. Done when that cannot happen in a session of realistic length.

## 8. Seeing what is going on

- **An inspector.** Entities, their components, the systems and how long each took, the events of the last tick. Done when a bug can be found without adding a `console.log`.
- **Tracing.** A layer that turns each system into a span. `System.withSpan` exists; this makes it one line to switch on for a whole app.
- **A documentation site.** Built from the README, these documents and the doc comments.
- **Plugins that can be switched off.** Removing a plugin's systems while the app runs, for tools and for tests.

## Decisions waiting to be made

Not work yet; each needs an answer before the item that depends on it.

- **One entry or several.** The storage core imports nothing from Effect and could be `arcadekit/ecs`. Renderers and netcode could be entries or packages. Needed by milestone 5.
- **Raw columns under `noUncheckedIndexedAccess`.** Every read in an `eachChunk` loop needs a `!`. Accept it, or find an API for the fast path that does not. Whatever it is should also let a raw loop say which columns it only reads: change detection has to count every row `eachChunk` hands out as written, and a handler's transaction copies every column it hands out, for want of that.
- **Sparse data in raw loops.** A sparse component arrives as `{ columns, indexOf }`, which works and reads badly.
- **How a game is laid out on disk.** One plugin per folder is the obvious answer; the examples are single files and do not show it.
