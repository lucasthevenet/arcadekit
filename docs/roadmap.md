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

Done. Components for where a thing is, `arcadekit/Transform3d` and, for a flat game, `arcadekit/Transform2d`, which the rules write and a renderer reads. A Three.js plugin, as a package of its own, [`@arcadekit/three`](../packages/three/README.md): `Three.instances`, which draws every entity of a kind as one instance of one mesh by reading the columns raw, and `Three.objects`, which keeps an Object3D per entity; ten thousand moving objects draw with nothing allocated per object per frame, which a test measures, each in a colour of its own if the game gives it one, in a look that is there from the start or made of a level's assets while they are loaded, and each can be drawn between its last two places, with what that takes kept by the renderer and not by the world. A view bridge, `arcadekit/View`: the game declares the values a UI may see and publishes each from the frame stage when it is not the value the UI has, and the UI, which holds a bridge and nothing of the game, acts by sending actions that the input stage issues and logs; the example page's menu and heads-up display are built on it twice, with the DOM and with React. And sound, `arcadekit/Sound`: a system of the frame stage plays the cues that the simulation's events stand for, through a player that throws in the tick, to an output that in a page is Web Audio. The READMEs of the two packages describe each, Music is `Sound.music`: a system of the frame stage says each frame what a channel should be playing, from the game as it is, and the output starts, fades and stops what that takes, so a game that is loaded has its music. A level's sounds are clips, assets of its bundle. The READMEs say what is not done: an outcome for what a UI sent; a sound heard from where it is; music kept in time.

These are plugins, not part of the core: a game that draws with something else leaves them out. The Three.js plugin is a package of its own, with `arcadekit` and `three` as peers: what needs a library of its own is not an entry of `arcadekit`. The view bridge and sound are entries of `arcadekit`, as every module is. They import Effect alone: what binds the bridge to a particular UI library is a few lines in the game or a package of its own, and what plays a sound in a page is in `arcadekit/Browser`. More than one player and tools stand on these.

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

## To revisit before a stable release

Not a milestone: a list that is added to as the work goes, and gone through before the first stable version. Each line is a thing that goes wrong with no error, and that only someone who knows how the inside works would avoid: nothing in the types or at run time stops it, and the README's sentence about it is all there is. Before a stable release each one is closed, by code that stops it or by a design that leaves no room for it, or kept on purpose and said plainly where a game's author will read it.

What is merely not built yet is not here: that is the READMEs' "Not done yet". When a line here is closed, take it out in the same commit.

The order systems run in:

- **`System.before` and `System.after` move a system past everything listed in between.** One that says `System.before(other)` is pulled ahead of where `other` was listed, and with it ahead of every system listed between the two, which said nothing; and a plugin's systems are listed before the app's own. Adding such a system leaves the others in the order they were, which is the point, but the one that moved may now run before something it reads from. What a frame draws with no longer does this: a renderer's last step is in `"postFrame"`, and nothing has to say `before` it.
- **A system that reacts through a change query, listed before the system that makes the change, reacts a tick late.** In a game that ticks when needed, one such system gets the one tick that follows the last and two in a row are a tick short: the game rests with work undone, unless the system that changed something asks for a tick with `Ticks.more`.

Ticks, frames and real time:

- **A system that has work every tick and does not say so stops when the game rests.** A game that ticks when needed rests when the app sees nothing waiting: actions, states, scripts, events, and what a system said with `Ticks.more`. A system that counts a clock down in a field and never asks is not told apart from one with nothing to do, and nothing says so. To close it: nothing cheap is known. The world's hash before and after a tick would tell, at the cost of a hash a tick.
- **A tick reads the devices unless it is told not to.** `App.replay` tells it. Whatever else runs a game again from a log by hand, a rollback or a tool, has to say `{ input: false }` itself, or the keys of the machine it runs on are reported into the game it is re-running, and nothing says so. And a game that steps its app by hand still has to run a tick when its UI has sent something: nothing ticks for it.
- **`smooth: true` draws a tick behind.** A game stepped by hand and drawn with `app.frame(0)` shows the tick before the one it just ran. A test that looks at what is drawn has to know.
- **`Effect.sleep`, a promise, or any wait in real time resumes outside the tick**, and a fiber started with `Effect.forkDetach` is not watched by the app. Either changes the game at a moment no replay repeats. Scripts wait with `Script.nextTick`, `Script.sleep` or an event's `wait`; nothing refuses the others.
- **`Assets.load` in a script** resumes in whatever tick the file arrives in. It is not refused there.

What a replay, a save and the hash do not hold:

- **A write through a raw column is not seen by anything.** In the frame and input stages it changes the game unless `verifyFrames` is on; through a query that says it only reads, it is written all the same; and no change query hears of it.
- **A refused action does not undo what is outside the world**: an object in a field changed in place, a call to a service of the game's own, a script it started.
- **A save holds no scripts, and the log does not say when one was started by hand** or the delta and number of ticks it was recorded at. Whoever loads or replays has to know and supply them.
- **The hash is of the world only**: not the events waiting, what change queries have yet to visit, the actions queued, or how far a script has got. Two games with the same hash can go different ways.
- **An entity handle kept across 1,024 reuses of its slot names a newer entity.**

Values that have to be right and are not checked:

- **A field left out of `Component.of` is NaN, not 0, where the compiler is not asked.** In TypeScript it does not compile: `of` takes every field. From JavaScript, or past a cast, a float that was left out is NaN, an integer is 0, and a `Transform3d.Position` with no `z` draws nowhere. Only a component added with no value at all is zeroed.
- **A `Transform3d.Rotation` has to be a unit quaternion.** One that is not draws skewed.
- **An instance's colour is in the renderer's linear colour space**, not a hex code's bytes over 255, and from 0 to 1. Either mistake draws the wrong colour and no more.
- **An entity with both a `Transform3d.Position` and a `Transform2d.Position` is drawn from the first**, and its `Transform2d` rotation and scale are then not read.
- **A texture made by `Three.texture` cannot be turned over in `prepare`**: Three.js does not read `flipY` of a texture made of a bitmap, and setting it does nothing.
- **Two `Sound.music` systems are two channels, by their names.** Two that were meant to be one score, a menu's and a level's, play on top of each other, each fading as if it were alone.
- **A cue asked for before the page was first touched is dropped; a track is kept.** The first sound of a game that starts with a cue is not heard. Nothing says so.

Who lets go of what:

- **A geometry and a material given to `Three.instances` are the game's to dispose of**, and so is whatever `make` of `Three.objects` made, through `free`. Nothing here does, and nothing says when one was forgotten.
- **A loader of Three.js that fetches for itself** does not go through `Assets.Loader`: a test's files in memory do not serve it, and an interrupted load does not give those requests up. A glTF model's own files no longer are such, since `Gltf.model` fetches them; what is left is the decoder a compressed model is given in `prepare`, and any asset of the game's own made around another loader, an FBX's, say. A streamed track, `Browser.stream`, is fetched by the page in the same way, on purpose: a test that provides files in memory hears nothing of it and has to play a clip of its own.

Reported, and not settled:

- **A page's sound after a laptop's lid was shut and opened.** With the example page of `arcadekit` on a MacBook: music playing, the lid shut and opened, the game played again, and the sound took a moment to come back and then came with its first notes all at once, as if they had been queued. Other apps on the same machine did not do it. One cause was found and closed: cues played while the page's audio was asleep or still waking were started all the same, and were heard together when it woke; they are dropped now. That was reproduced only with an audio made slow to wake in headless Chromium, never with a real lid, and it was not heard again on the machine after the change. Before a stable release: shut a real lid, on more than one browser, and listen. If it is still there, look at what the audio's clock does across the sleep (`currentTime` against the wall clock, and `state`), and at whether the looping track should be started afresh when the page is seen again in place of being woken.

## Decisions waiting to be made

Not work yet; each needs an answer before the item that depends on it.

- **Raw columns under `noUncheckedIndexedAccess`.** Every read in an `eachChunk` loop needs a `!`. Accept it, or find an API for the fast path that does not.
- **Sparse data in raw loops.** A sparse component arrives as `{ columns, indexOf }`, which works and reads badly.
- **How a game is laid out on disk.** One plugin per folder is the obvious answer; the examples are single files and do not show it.

Decided, and no longer waiting: no UI library. The previous version drew its UI with Foldkit; this one does not depend on it, or on any other. Three.js is different, because it does a job the package would otherwise have to do itself. A game's UI reaches the game through the view bridge of milestone 5, with whatever library it likes.

Also decided: one entry or several. Several: an entry for every module, `arcadekit/App` and the rest, and `arcadekit` for all of them together, each importing Effect alone. What only a page can use is one entry, `arcadekit/Browser`, and starts a game in it. `arcadekit/ecs` is the storage core, which imports nothing. A UI bridge and netcode are each an entry of their own when they are built.

Also decided: a game that ticks when a player moves, in a page. It is an option of the frame loop and not a driver of its own: `ticks: "whenNeeded"`, on `Driver.frames`, `Driver.fixedStep` and `App.run`. The loop draws every frame and runs the input stage every frame, ticks while the app is not settled and once more after, and rests. What a menu sends through the view bridge is heard in the frame it is sent in.

Also decided: where a renderer lives. In a package of its own, `@arcadekit/three`, and not in an entry of `arcadekit` with Three.js as an optional peer, which is what this document said before. `arcadekit` then asks nobody for Three.js, and the plugin is versioned with the library it draws with.

Also decided: where the components for where a thing is live, and what they are called. In `arcadekit`, as `arcadekit/Transform3d` and `arcadekit/Transform2d`, each named for its dimensions, so that neither is the one a game gets without choosing. They were first in the renderer's package, in an entry that imported no Three.js, which made a server that runs a game's rules install the renderer. A game's rules write them, so they are the game's, and a renderer, sound that knows where a thing is, or netcode reads the same ones. A flat game has a variant of its own, `arcadekit/Transform2d`, in place of a `z` it does not use and a quaternion for a turn about one axis; whatever reads where things are reads both.
