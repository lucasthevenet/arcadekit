---
title: "Not done yet"
description: "What arcadekit and @arcadekit/three do not do yet, by area, for whoever is deciding whether the kit fits a game."
---

What arcadekit and `@arcadekit/three` do not do yet, by area, for whoever is deciding whether the kit fits a game. Each area names its guide. Where a line says a thing is the game's to do, nothing in the kit does it or checks it.

## Components and queries

See [components](guides/components.md) and [queries](guides/queries.md).

- A game picks one of the two transforms for a thing, and a plugin written for one does not read the other: code that should work in both asks for both. A `Transform2d` has no depth: what is in front of what in a flat game is for what draws it to say.
- An entity points at one target per relation, and a query cannot ask for what points at a given entity: `world.sources` gives those as a list.
- A singleton cannot be watched for changes: a change query is of entities.
- `Query.removed` gives the ids of the entities that lost a component, not the values it held.
- What a query only reads is the query's word. A raw column is a typed array all the same: a loop that writes one past the compiler has written it, and no change query hears of it and no refusal takes it back.
- `arcadekit/ecs` has no helper for writing a query: `world.view` is given a description written out as an object, `{ terms, withDefs, withoutDefs }`. `Query.all` and its kind are Effect's side of it, in `arcadekit`.

## Systems, states and plugins

See [systems](guides/systems.md), [states](guides/states.md) and [plugins](guides/plugins.md).

- What a system says it reads and writes is held as it runs, not proved when the app is made: a system that reaches for something it left out only in some ticks is refused in the first of them. Scripts and handlers say nothing and are in no check, and neither are the systems of the package's own plugins that run between ticks.
- A despawn is said by one component the entity has, and takes the rest with it, and whatever a relation hangs from it: a system that visits those entities by other components is not found to be in conflict with the one that despawned them.
- A conflict in the order of systems is settled by saying an order. Two systems that conflict and whose order does not matter cannot say so.
- A run condition is given to one system at a time: a plugin cannot be given one for all its systems. A script is not stopped by a state; it asks.
- Plugins cannot be added or removed while the app runs, and one plugin cannot replace or disable another's systems.

## Events and actions

See [events and actions](guides/events-and-actions.md).

- A schema checks a payload's shape. Whether an entity id in it is still alive, or belongs to the player who sent it, is for the handler to check, which is told who that is.
- A refused action does not undo what is outside the world: an object held in a field that the handler changed in place, a call to a service of the game's own, a script it started.
- An action enqueued with a payload its schema rejects is refused when its turn comes, as an event, and is not in the log, since it has no JSON form. A replay therefore does not repeat that one refusal, and in a session the other peers never hear of it.

## Scripts

See [scripts](guides/scripts.md).

- `Effect.sleep`, promises and other real-time waits resume outside the tick. Scripts should wait with `Script.nextTick`, `Script.sleep` (game time) or an event's `wait`.
- Only scripts started with `app.spawnScript` or `Script.spawn` are watched. Effect has no hook that would let the app see a fiber started with `Effect.forkDetach`.

## Ticks and frames

See [running a game](guides/running-a-game.md) and [ticks and frames](concepts/ticks-and-frames.md).

- A game that ticks when it is needed rests when nothing is waiting, and what is waiting is what the app can see, actions, states, scripts and events, and what a system said with `Ticks.more`. A system that has work every tick and does not say so stops with the game. A system that reacts to a change through a change query, listed before the system that makes the change, reacts a tick late, and the one tick that follows the last is all it is given; two such systems in a row are a tick short. Order them with `System.after`, or have the one that changed something ask for a tick.
- The frame loop always pauses while the tab is hidden. A game that has to go on in the background, such as one peer of several, cannot say so.
- Neither the frame stage nor the input stage can stop a write through the raw columns of `eachChunk`. `verifyFrames` finds one afterwards, at the cost of a hash of the world per system of those stages. A draw from `world.random` there is found when the stage ends, not where it is made.
- A frame system of the game's own that draws between two ticks works the place out itself, from a velocity or a previous position the simulation keeps: there is no helper for it in `arcadekit`. [`@arcadekit/three`](guides/drawing-with-three.md) does it for what it draws, with `smooth: true`, and keeps the place before to itself.
- `arcadekit/Browser` is one entry for everything a page has.
- No test of the package runs a page: its example page is opened in a browser by hand. The frame loop is tested against a display turned by hand, and `arcadekit/Browser` against stand-ins for `requestAnimationFrame`, the document and the window.

## Input

See [input](guides/input.md).

- The picture of the devices is one player's. Several players on one machine, or on several, bind their devices to actions that say whose they are.
- A gamepad's button is down or it is not: how far a trigger is pressed is not read. Nor are the wheel, text as it is typed, more than one finger at a time, or a pointer that is locked to the page.
- A button that is pressed twice between two readings of the devices was pressed once.
- The pointer's place is in CSS pixels of its target. A canvas that is drawn larger or smaller than its own size has to convert.
- Bindings are fixed when the system is made. A game that lets its player choose the keys writes a system of the input stage that looks them up.
- A tick reads the devices unless it is told not to. What runs a game again from its log by hand, with `dispatchByName` and `tick`, says `{ input: false }` as `App.replay` does, or the machine's own keys join in.

## Assets

See [assets](guides/assets.md).

- An asset is a picture, text, JSON or bytes. A font is for whoever draws with it to decode, with `Assets.make`.
- A bundle is loaded or it is not: it does not say how far along it is, and a file that two bundles name is fetched for each.
- A bundle that failed stays failed until its level is entered again. Nothing tries again by itself.
- `Assets.load` waits in real time. In a script it would resume in whatever tick the file happened to arrive in, and a replay of that script would fetch the file again: a script does not load.

## Sound

See [sound](guides/sound.md).

- A cue is played once and left to end: it cannot be stopped, and nothing is heard from where it is. A track that plays once says nothing when it has ended: the body that asked for it cannot tell, and what follows it is for the game to say.
- A streamed track that goes round may be heard to join where it does: the page's own player is not exact about it. A short piece that has to go round without a seam is given by its URL and decoded. A stream is fetched by the page and not through `Assets.Loader`, so a test plays `Sound.clip(name)` in its place.
- A channel fades in a straight line, from one track to the next in the same time. Two tracks are not kept in step, a track does not start where the last one was, and nothing is timed to a beat.
- A cue is one sound a frame, whatever speed each asked for it at: the loudest's. Two sounds of one file at once, a chord, are two names for it.
- A page's audio sleeps while the page is hidden, always, as its frame loop does. A game that is to be heard in the background cannot say so.
- The first sound a page can make is the one its user's first key or press sets off. Nothing is heard before that.

## A UI

See [a UI](guides/ui.md).

- A view is worked out and compared whole, every frame a UI is there. A game with a view that is costly to work out says when it is worth it with `System.runIf`.
- The UI is not told what became of an action it sent. A refusal is an `Action.Rejected` event, which a frame system can read and the game can publish as a view.
- What the UI sends is applied by the next tick, which under a driver is the frame it was sent in or the one after. A game that steps its app by hand runs a tick itself when its UI has sent something.
- A view's value is an object of this program, with no schema: a UI in another thread or on another machine is not served.
- `ui.send` takes any action as far as the compiler knows. That the game has a handler for it is checked when it is sent, and a bridge is not typed by the game it will be given to.

## Drawing with Three.js

arcadekit draws nothing itself: its own example page draws on a canvas by hand. `@arcadekit/three` draws a game with Three.js, less what follows. See [drawing with Three.js](guides/drawing-with-three.md).

- Drawing between two ticks is one setting and one distance per kind. An entity cannot say for itself that it jumped, a kind cannot be drawn ahead of the game in place of behind it, and the blending is a pass of its own that costs more than it has to: one check per entity per component, where one per entity would do.
- An instance has a place and a colour and nothing else: no opacity of its own, since a colour is three numbers, and no other attribute per instance, a frame of a sheet of sprites, say.
- A colour is for instances. `Three.objects` reads none: an object's colour is its material's, which is the game's to set in a frame system of its own.
- A flat game's entities are all at 0 of the third axis. What is in front is said per kind, by its mesh or its objects; an entity has no depth or layer of its own, and nothing sorts them.
- The two transforms do not mix: an entity placed in the plane is not turned by a quaternion, and one placed in three dimensions is not turned by an angle.
- One kind of entity is one geometry and one material: given when the system is made, or made of one bundle's assets while that bundle is loaded. A look does not change for any other reason, a setting of the player's, say, and an entity cannot say for itself which of several looks it has: that is a kind per look.
- While a kind's bundle is loading nothing of the kind is drawn: there is no look to stand in for the one that is on its way.
- A model is drawn as it stands. Its animations are loaded and not played: there is no mixer here, and one that is skinned needs more than `scene.clone()` to be copied, which is the game's to bring (`SkeletonUtils.clone` of Three.js).
- A compressed model, with Draco, meshopt or KTX2 pictures, needs its decoder given to the loader in `prepare`, and that decoder fetches its own files, which do not come through `Assets.Loader`.
- An asset of the game's own made around another loader of Three.js, an FBX's, say, fetches what that loader fetches for itself: only a glTF model's files are brought through `Assets.Loader` here.
- Instances are in no order, so a material that needs its instances sorted back to front is not served.
- A mesh of instances is never culled as a whole unless `prepare` says how.
- Nothing is a child of anything: an entity's place is its place in the scene. An object that hangs from another is the game's to arrange in `make`.
- `Three.layerRenderer` takes a renderer that is ready to draw. `WebGPURenderer` has to be initialised first, which is the game's to wait for.
- No test of the package opens a page: `Three.layerWebGL` itself, the one line that makes a `WebGLRenderer`, is tried by hand in headless Chromium with the example page.

## Saves and replays

See [saving and loading](guides/saving-and-loading.md) and [replays](guides/replays.md).

- A save does not hold scripts, so a script that keeps its progress in its own variables starts over when a game is loaded. Nor does it hold what a game's own services hold.
- A save is refused while an action or an event with no schema is waiting, which for a game that emits such an event every tick is always.
- The log does not say when a script was started by hand with `app.spawnScript`, nor the delta and the number of ticks of the game it records. A replay is told those by its caller.
- The hash covers the world and nothing else: not the events waiting to be read, what change queries have yet to visit, the actions queued for the next tick, or how far each script has got.

## Several players

See [lockstep and rollback](guides/lockstep-and-rollback.md) and [transports and relays](guides/transports-and-relays.md).

- A session's peers are fixed when it is made. Nobody joins a game in progress or leaves one, and a peer that stops is waited for.
- Every message has to arrive. One that is lost stops the game for everyone: nothing asks for it again, and a transport whose socket has closed does not connect again. Nothing says that a peer has gone quiet but `session.waitingFor`.
- Peers that have come apart stop. Nothing brings them back together: a game that wants to go on has every peer load one peer's save and makes its sessions again.
- A game in a session ticks all the time. One that ticks when it is needed, `ticks: "whenNeeded"`, is not for several peers yet: a session does not say when it is settled.
- Who issued an action is who its message says it is from, and only a relay vouches for that. Through `Transport.layerBroadcastChannel`, or a transport of the game's own that does not, a peer can send a message in another's name. The peers that took it and the one whose name it was then hold different games, and stop with `Lockstep.Drifted`: it is found, not prevented.
- A game played with rollback is drawn and heard as it is predicted. A sound for something that is then taken back was played, an event of a tick that is run again is heard again by the frame stage, and its change queries visit everything after each rewind. Nothing tells what draws which ticks are final but `session.confirmed`.
- A script is started again by every rewind, and what a service of the game's own holds is not put back. With rollback, what the simulation reads is in the world.
- The relay is a handler, and hosting it is the game's. The examples have a WebSocket server under Node and a Durable Object on Cloudflare, declared with Alchemy, and neither is a package to install: a game copies the one it needs. The Cloudflare one was run under `alchemy dev` and never deployed from the repository, and there is none for AWS. A relay does not say who has come and gone, does not slow a peer that sends too much, and does not ask who a peer is: letting a peer in under a name is the host's to settle before `Relay.join`.

## Performance

See [performance](guides/performance.md).

- Systems run in sequence on one thread. Running them side by side on workers was measured and not built: `pnpm --filter arcadekit bench:parallel` shares a loop's rows between four threads over shared memory, and a flock of 100,000 goes from 3.7 ms to 1.3 ms, where the 100,000 entities of the benchmark move in a quarter of a millisecond on one.
- A rollback session keeps a snapshot of the whole world for each tick it is not sure of, and loads one to go back. For a very large world that is the cost of every such tick: nothing keeps only what changed.
- A world holds at most 4,194,304 entities at once, and an id takes eight bytes wherever it is kept.
