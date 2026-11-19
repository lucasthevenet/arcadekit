# Roadmap

What to build next, in order, and why in that order. The [docs site](website/src/content/docs/) describes what exists today and nothing else: what is not built is [below](#not-built-yet), by area, and never on the site. The [`arcadekit-development` skill](.agents/skills/arcadekit-development/SKILL.md) says how to write what comes next.

Each item says what it is for, what has to be true for it to be done, and what it depends on. An item is not done until it has tests that fail when it is broken, a guide on the site, and a doc comment on each of its exports.

The order follows one rule: build what later items stand on first. Saving needs a seeded random source; netcode needs saving; a renderer needs a frame loop. Within a milestone the items are in order too.

Two lists are beside this one, each read when it is needed and not before:

- [roadmap/decisions.md](roadmap/decisions.md): what an item waits on, and what was decided and why.
- [roadmap/to-revisit.md](roadmap/to-revisit.md): what goes wrong with no error, by area, to be closed before a stable release.

## Next

### 0. Housekeeping

Small, and worth doing before anything is built on top.

- **Move to TypeScript 7.1 when it is released.** The declaration build prints a deprecation warning on 7.0. Done when `pnpm build` is quiet.

### 7. Speed and scale

Only with a benchmark that shows the need.

- **Parallel systems.** Workers over shared memory, for systems whose declared access does not overlap. Done when it is faster on a real workload, and still deterministic. Measured, and not built: there is two to four times to gain, in a game larger than any the package has been tried on, and it waits on four decisions that are still open. [What was measured](roadmap/decisions.md#parallel-systems-what-was-measured) and [what it waits on](roadmap/decisions.md#waiting) are in the decisions.

### 8. Seeing what is going on

- **An inspector.** Entities, their components, the systems and how long each took, the events of the last tick. Done when a bug can be found without adding a `console.log`.
- **Tracing.** A layer that turns each system into a span. `System.withSpan` exists; this makes it one line to switch on for a whole app.
- **Plugins that can be switched off.** Removing a plugin's systems while the app runs, for tools and for tests.

## Not built yet

What arcadekit and `@arcadekit/three` do not do, by area, for whoever decides what to build next. None of it is on the site, which describes only what exists. An item that grows into work moves up to [Next](#next), or becomes an issue. What goes wrong with no error is in [roadmap/to-revisit.md](roadmap/to-revisit.md), not here.

### Components and queries

- **A query by relation target.** An entity points at one target per relation, and a query cannot ask for the entities that point at a given one: `world.sources` returns them as a list.
- **Change detection for singletons.** A change query watches components of entities; a singleton cannot be watched.
- **Removed values.** `Query.removed` gives the ids of the entities that lost a component, not the values it held.
- **Read-only raw columns.** `Query.reads` is a promise the compiler holds for `each`. A raw column is a typed array all the same: a loop that writes one past the compiler has written it, and no change query sees it and no refusal undoes it.
- **A query builder for `arcadekit/ecs`.** `world.view` takes a description written out as an object, `{ terms, withDefs, withoutDefs }`. `Query.all` and its kind are Effect's side of it, in `arcadekit`.
- **Depth for a flat game.** A `Transform2d` has no depth or layer: what is in front is said per kind by what draws it.
- **One transform for both.** A plugin written for `Transform3d` does not read `Transform2d`, and the other way round: code that works in both, as a renderer does, asks for both.

### Systems, states and plugins

- **Access proved when the app is made.** What a system declares it reads and writes is checked as it runs, so a system that reaches outside its declaration only in some ticks is refused in the first of them. Scripts and handlers declare nothing and are in no check, and neither are the systems of the package's own plugins that run between ticks.
- **An order that does not matter.** Two systems in conflict are settled only by giving them an order: there is no way to say that either order is fine.
- **Conditions for a whole plugin.** A run condition is given one system at a time, and a script is not paused by a state; it checks.
- **Plugins at run time.** Plugins cannot be added or removed while the app runs, and one plugin cannot replace or disable another's systems. See _Plugins that can be switched off_ under [Next](#next).

### Ticks and frames

- **A game that runs in the background.** The frame loop pauses while the tab is hidden, and so does a page's audio. A game that has to keep running, such as one peer of several, cannot opt out.
- **Interpolation for a game's own frame systems.** A frame system that draws between two ticks works the position out itself, from a velocity or a previous position the simulation keeps. `@arcadekit/three` does it for what it draws, with `smooth: true`, and keeps the previous position to itself.
- **A smaller `arcadekit/Browser`.** It is one entry for everything a page has.
- **Tests that run a page.** No test of either package opens a browser: the example pages are opened by hand. The frame loop is tested against a display turned by hand, and `arcadekit/Browser` against stand-ins for `requestAnimationFrame`, the document and the window. `Three.layerWebGL` is tried by hand in headless Chromium with the example page.

### Input

- **Several local players.** The device state is one player's. Several players, on one machine or on several, bind their devices to actions that carry who they are.
- **More of the devices.** How far a trigger is pressed, the wheel, text as it is typed, more than one touch at a time, and pointer lock are not read.
- **Presses between two samples.** A button pressed twice between two samples of the devices counts as one press.
- **Pointer position in canvas units.** The pointer's position is in CSS pixels of its target. A canvas drawn larger or smaller than its own size has to convert.
- **Rebinding.** Bindings are fixed when the system is made. A game whose player chooses the keys writes an input-stage system that looks them up.

### Assets

- **Fonts.** An asset is a picture, a sound, text, JSON or bytes. A font is decoded by whoever draws with it, with `Assets.make`.
- **Progress and sharing.** A bundle does not report progress, and a file named by two bundles is fetched for each.
- **Retries.** A bundle that failed stays failed until its level is entered again.

### Sound

- **Cues that can be stopped, and positional sound.** A cue plays once to its end. A track played `once` does not report that it has ended.
- **Gapless streamed loops.** A streamed track may be heard to join where it loops, and a stream is fetched by the page rather than through `Assets.Loader`.
- **More of music.** A channel fades linearly, from one track to the next in the same time. Two tracks are not kept in sync, a track does not resume where the last one was, and nothing is timed to a beat.
- **The same cue twice in a frame.** A cue is one sound a frame, at the loudest volume asked for. Two sounds of one file at once take two names for it.

### A UI

- **Views worked out only when needed.** A view is computed and compared whole every frame. A game with a costly view gates it with `System.runIf`.
- **What became of an action.** The UI is not told the outcome of an action it sent. A refusal is an `Action.Rejected` event, which a frame system can publish as a view.
- **A UI in another thread or on another machine.** A view's value is an object of this program, with no schema.
- **A bridge typed by its game.** `ui.send` takes any action as far as the compiler knows. That the game has a handler for it is checked when it is sent.

### Drawing with Three.js

- **Finer interpolation.** Interpolation is one setting and one `snap` distance per kind. An entity cannot mark a jump of its own, a kind cannot be drawn ahead of the game, and the blend costs one check per entity per component where one per entity would do.
- **More per instance.** An instance has a position and a colour: no opacity of its own, and no other attribute, such as a frame of a sprite sheet.
- **A colour for objects.** `Three.objects` reads no colour component: an object's colour is its material's, set by the game in a frame system.
- **Depth and sorting in a flat game.** Flat entities are all at 0 on the third axis. What is in front is set per kind, by its mesh or objects, and nothing sorts entities.
- **Several looks for one kind.** A kind is one geometry and one material, given when the system is made or made from one bundle while that bundle is loaded. Changing a look for any other reason, or choosing among several per entity, takes a kind per look.
- **A placeholder while loading.** Nothing of a kind is drawn while its bundle loads.
- **Animation.** A model's animations are loaded and not played: there is no mixer, and a skinned model needs more than `scene.clone()` to be copied (`SkeletonUtils.clone` of Three.js).
- **Every fetch through `Assets.Loader`.** The decoder a compressed model is given in `prepare` fetches its own files, and so does an asset made around another loader of Three.js, an FBX's, say. Only a glTF model's own files go through `Assets.Loader`.
- **Sorted instances.** Instances are in no order, so a material that needs them sorted back to front is not served.
- **Culling for instance meshes.** A mesh of instances is never culled unless `prepare` sets it up.
- **A hierarchy.** An entity's position is its position in the scene. An object attached to another is arranged by the game in `make`.
- **WebGPU set up for you.** `Three.layerRenderer` takes a renderer that is ready to draw: a `WebGPURenderer` is initialised by the game first.

### Saves and replays

- **Scripts and services in a save.** A save holds no scripts, so a script that keeps its progress in its own variables starts over when a game is loaded, and nothing of a game's own services is saved.
- **Saving with schema-less events waiting.** A save is refused while an action or an event with no schema is waiting, which for a game that emits such an event every tick is always.
- **A log that says how it was recorded.** The log does not record a script started by hand with `app.spawnScript`, or the `delta` and the number of ticks of the game. A replay is given them by its caller.
- **A hash of more than the world.** The hash does not cover the events waiting to be read, what change queries have not visited, the actions queued for the next tick, or how far each script has got.

### Several players

- **Joining and leaving.** A session's peers are fixed when it is made. Nobody joins a game in progress or leaves one, and a peer that stops is waited for. Nothing reports a quiet peer but `session.waitingFor`.
- **Lost messages and reconnecting.** Every message has to arrive: one that is lost stops the game for everyone, and a transport whose socket closed does not reconnect.
- **Recovering from drift.** Peers that come apart stop. To go on, every peer loads one peer's save and makes its sessions again.
- **Ticking when needed in a session.** A game in a session ticks all the time: a session does not say when it is settled, so `ticks: "whenNeeded"` is for a game of one.
- **Proof of who sent a message.** Only a relay vouches for who issued an action. Through `Transport.layerBroadcastChannel`, or a transport of the game's own, a peer can send a message in another's name, which ends in `Lockstep.Drifted`.
- **Rollback for the frame stage.** A game played with rollback is drawn and heard as predicted: a sound for something taken back was played, a re-run tick's events are heard again, and change queries visit everything after each rewind. Nothing tells the frame stage which ticks are final but `session.confirmed`.
- **Rollback for scripts and services.** A rewind restarts each plugin's scripts, and what a game's own service holds is not restored.
- **Relays to install.** The Node and Cloudflare relays are examples to copy, not packages. There is none for AWS, and the Cloudflare one has been run under `alchemy dev` and not deployed from the repository. A relay does not report who has come and gone, does not rate-limit a peer, and does not authenticate one: the host decides who may use a name before it calls `Relay.join`.

### Performance

- **Parallel systems.** Systems run in sequence on one thread. See _Parallel systems_ under [Next](#next).
- **Incremental rollback snapshots.** A rollback session keeps a snapshot of the whole world for each tick it is not sure of, and loads one to go back. For a very large world that is the cost of every such tick.
- **More entities.** A world holds at most 4,194,304 entities at once, and an id takes eight bytes wherever it is kept.

## Done

What is built is described where a game's author reads it: each line names the pages of the site that do.

1. **Determinism you can rely on.** [Determinism](website/src/content/docs/concepts/determinism.md): [random numbers](website/src/content/docs/guides/systems.md#random-numbers), [the world's hash](website/src/content/docs/guides/replays.md#the-worlds-hash), [replays](website/src/content/docs/guides/replays.md) that check themselves, [refusals](website/src/content/docs/guides/events-and-actions.md#checking-and-refusing) that leave nothing behind, and a log that holds what came from outside the simulation. Saving and netcode stand on these.
2. **Saving and loading.** [Saving and loading](website/src/content/docs/guides/saving-and-loading.md): snapshots, [fields](website/src/content/docs/guides/components.md#field-types) that say what saving does with them, a game saved with what was waiting in it, and versions and migrations.
3. **What every game ends up needing.** [Change queries](website/src/content/docs/guides/queries.md#change-detection), [singletons](website/src/content/docs/guides/components.md#singletons), [relations](website/src/content/docs/guides/components.md#relations), [states](website/src/content/docs/guides/states.md) and run conditions, and [a frame stage](website/src/content/docs/concepts/ticks-and-frames.md) that draws the game between ticks and cannot change the world. Running in a browser stands on the last.
4. **Running in a browser.** A frame loop and `App.run`, [in a page](website/src/content/docs/guides/running-a-game.md); [input](website/src/content/docs/guides/input.md), through the action log; and [assets](website/src/content/docs/guides/assets.md), loaded as a scoped resource. Drawing and UI stand on these.
5. **Drawing and UI.** [Where a thing is](website/src/content/docs/guides/transforms.md); a Three.js plugin, as a package of its own, [`@arcadekit/three`](website/src/content/docs/guides/drawing-with-three.md); [the view bridge](website/src/content/docs/guides/ui.md); and [sound](website/src/content/docs/guides/sound.md). These are plugins, not part of the core: a game that draws with something else leaves them out. More than one player and tools stand on these.
6. **More than one player.** [Several players](website/src/content/docs/concepts/several-players.md): [lockstep, drift detection and rollback](website/src/content/docs/guides/lockstep-and-rollback.md), [a transport](website/src/content/docs/guides/transports-and-relays.md) and [a relay](website/src/content/docs/guides/hosting-a-relay.md). Depends on milestones 1 and 2 entirely.
7. **Speed and scale**, so far. Accessors without code generation, for [a page under a Content Security Policy](website/src/content/docs/guides/running-a-game.md#under-a-content-security-policy); [systems that say what they read and write](website/src/content/docs/guides/system-access.md), which is what running systems side by side will stand on; [wider entity ids](website/src/content/docs/concepts/entities-and-systems.md#entity-ids); and benchmarks in CI, which `packages/arcadekit/bench/Verdict.ts` describes. [Performance](website/src/content/docs/guides/performance.md) has the numbers.
8. **A documentation site.** [arcadekit.dev](https://arcadekit.dev), from `website/`: its own pages, and a reference made from the doc comments. The READMEs are a description and links to it.
