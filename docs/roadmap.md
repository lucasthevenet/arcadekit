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

Done. Queries for what changed, with writes noticed per row; singletons, which are the world's and saved with it; relations, whose holders go with a despawned target or lose the relation; states, with hooks for entering and leaving them and conditions for when a system runs; and a frame stage that draws the game between ticks, is told how far between them it is, and cannot change the world. The package's [README](../packages/arcadekit/README.md) describes each. Running in a browser stands on the last.

## 4. Running in a browser

Done. A frame loop, `Driver.frames`, that follows the page's repaints, pauses while the tab is hidden and leaves nothing running when it is interrupted; input, read once per tick in a stage of its own, kept as a picture in the world by `Input.plugin` and turned into the game's own actions by `Input.bind`, all of it through the action log, so that a replay reads no device; assets, loaded as a scoped resource, with `Assets.during` keeping a level's for as long as the game is in it; and `App.run`, the entry point that the platform's `runMain` is given. `examples/page` is a game that runs in a page, and it and the demo are started that way; the duel, which ticks once a move, steps its app itself. The package's [README](../packages/arcadekit/README.md) describes each. Drawing and UI stand on these.

## 5. Drawing and UI

These are plugins, not part of the core: a game that draws with something else leaves them out.

- **A Three.js plugin.** Components for what is drawn, and a per-frame system that copies positions from columns to the scene. Instanced meshes read a column directly. Done when ten thousand moving objects draw without one allocation per object per frame.
- **A view bridge.** How a game's menus and heads-up display, written with any UI library or none, see the game and act on it. The game says which values the UI may see; they are published once per frame, from the frame stage, and only when they changed; and the UI acts only by sending actions, like every other source of input. Done when a menu and a heads-up display are built on it twice, once with the page's own DOM and once with a UI library, with neither holding a reference to the world, and a value that did not change costs the UI nothing.
- **Sound.** A service that plays a named cue, driven by events. Done when the simulation never calls it directly.

Each is an entry of `arcadekit` of its own, as every module is. The Three.js plugin has the library it draws with as an optional peer, which `three` is already. The view bridge has none: it imports Effect alone, and what binds it to a particular UI library is a few lines in the game or a package of its own.

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
- **Systems that declare what they read and write.** The first step towards running systems in parallel, and useful on its own for ordering and for tools. A query can already say which of its terms it only reads (`Query.reads`), so most of what a system reads and writes is the sum of its queries; what it does through `World`, `Commands` and singletons is not declared yet. Done when the order of systems can be checked for conflicts.
- **Parallel systems.** Workers over shared memory, for systems whose declared access does not overlap. Done when it is faster on a real workload, and still deterministic.
- **Wider entity ids.** A handle is 22 bits of index and 10 of generation; a slot reused 1,024 times can alias an old handle. Done when that cannot happen in a session of realistic length.

## 8. Seeing what is going on

- **An inspector.** Entities, their components, the systems and how long each took, the events of the last tick. Done when a bug can be found without adding a `console.log`.
- **Tracing.** A layer that turns each system into a span. `System.withSpan` exists; this makes it one line to switch on for a whole app.
- **A documentation site.** Built from the README, these documents and the doc comments.
- **Plugins that can be switched off.** Removing a plugin's systems while the app runs, for tools and for tests.

## Decisions waiting to be made

Not work yet; each needs an answer before the item that depends on it.

- **Raw columns under `noUncheckedIndexedAccess`.** Every read in an `eachChunk` loop needs a `!`. Accept it, or find an API for the fast path that does not.
- **Sparse data in raw loops.** A sparse component arrives as `{ columns, indexOf }`, which works and reads badly.
- **A game that ticks when a player moves, in a page.** `App.run` and `Driver.frames` tick in real time. A turn-based game wants its frames at the display's rate and its ticks when a move is made, with the input stage before each. Whether that is an option of the frame loop or a driver of its own is open; the duel example steps its app by hand meanwhile.
- **How a game is laid out on disk.** One plugin per folder is the obvious answer; the examples are single files and do not show it.

Decided, and no longer waiting: no UI library. The previous version drew its UI with Foldkit; this one does not depend on it, or on any other. Three.js is different, because it does a job the package would otherwise have to do itself. A game's UI reaches the game through the view bridge of milestone 5, with whatever library it likes.

Also decided: one entry or several. Several: an entry for every module, `arcadekit/App` and the rest, and `arcadekit` for all of them together, each importing Effect alone. What only a page can use is one entry, `arcadekit/Browser`, and starts a game in it. `arcadekit/ecs` is the storage core, which imports nothing. A renderer, a UI bridge and netcode are each an entry of their own when they are built.
