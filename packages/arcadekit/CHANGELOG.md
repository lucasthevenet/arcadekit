# arcadekit

## 0.8.0

### Minor Changes

- [#299](https://github.com/lucasthevenet/arcadekit/pull/299) [`99e782c`](https://github.com/lucasthevenet/arcadekit/commit/99e782c8c60402e5425921ca01bfa7e8f81a421b) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A view bridge is made from its game, and `bridge.send` takes only an action the game has a handler for: any other does not compile, where it threw when it was sent or in the game's first input stage. A UI names the actions it sends in its bridge's type, `View.Bridge<typeof Start | typeof Quit>`, and is handed only the bridge of a game that handles each of them.

  **Breaking**

  - `View.makeBridge()` is `View.makeBridge(game)`, given the game the bridge is provided to: `const ui = View.makeBridge(Arcade)` beside `App.make(Arcade)`.
  - `View.Bridge` takes the actions it sends, `View.Bridge<typeof NewGame>`. A `View.Bridge` with none, as a UI was typed before, reads views and sends nothing: name the actions the UI sends.
  - `send` no longer throws for an action the game has no handler for, since it does not compile. A bridge provided to the app of another game can still send one, which throws in that app's input stage.

- [#466](https://github.com/lucasthevenet/arcadekit/pull/466) [`99c7ac6`](https://github.com/lucasthevenet/arcadekit/commit/99c7ac6c738351cbcdb4026aa0be54816aa1a74d) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A transport's `send` and `receive` return an Effect, which fails with `Transport.Closed` once its socket has closed for good. A connected session's `tick` fails with it, and so does `Driver.run` of a game of several peers, so a program catches it by its tag, `"TransportClosed"`, beside `Transport.Left`, `Drift.Unlike`, `Drift.Drifted` and `Save.Refused`. A transport used after its connection was closed dies, and says so, where it threw.

  What breaks:

  - `listener.send(message)` and `listener.receive()` of a `Transport.Listener`, from `Transport.listen`, a hub's `port` or `Transport.fromWire`, are `yield* listener.send(message)` and `yield* listener.receive()`. Where `receive` threw `Transport.Closed`, `yield* Effect.result(listener.receive())` gives it as a value.
  - A `Transport.Listener` written by hand returns an Effect from both calls, `Effect.sync(...)` for one that cannot fail.
  - `Driver.run` of a connected session fails with `Transport.Closed`, where it died with it.

- [#373](https://github.com/lucasthevenet/arcadekit/pull/373) [`99feb2d`](https://github.com/lucasthevenet/arcadekit/commit/99feb2d1762692209abba062ad87ee4defa8362f) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A component can require others. `Component.define` and `Component.tag` take `requires`, and a spawn or an add fills in each required component the entity lacks, bare or with the value written there. `Commands.spawns` names what is filled in, so the order of systems sees it, and `RequiredOf` reads it in the type.

  **Breaking**

  - `Three.instances` and `Three.objects` refuse a kind whose `of` doesn't require the `Position` of its `transform`. An entity spawned without one was never drawn, and nothing said so. Before, `Component.tag("game/Rock")`; now, `Component.tag("game/Rock", { requires: [Transform3d.Position] })`.
  - A replay recorded before a component required something spawns it without, and drifts from a game that fills it in. Record it again once the component requires others.
  - `ComponentDef` takes a fourth type parameter and `ComponentValue` a third, the names a component requires. A `ComponentDef<S, St, N>` written out by hand reads as requiring any name, which `Commands.spawns` leaves out of the order check: write `ComponentDef<S, St, N, never>` for one that requires nothing.

- [#467](https://github.com/lucasthevenet/arcadekit/pull/467) [`b60ff97`](https://github.com/lucasthevenet/arcadekit/commit/b60ff974893ddf64558bbd05172323a66394c37e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A connection is its session: `Transport.connect(session)` returns a `Transport.Connected` that has the session's `app`, `waitingFor`, `confirmed`, `drifted` and `stats` beside `away`, so a page reads what to show the player from what `Driver.run` hands `ready`, and catches a drift or a peer that left from `Driver.run` by its tag. A session says how far ahead of the slowest peer it is, `session.lead`, from an `at` and a `lead` that every message now carries, and a driver runs a session's ticks at half their rate while its lead is 2 or more, so a peer whose clock runs fast neither waits for the others nor makes them rewind.

  The names of `arcadekit/net` are fewer. What was merged:

  - `net/Peer` is gone, entry and module: `Peer.Peer` is part of `Session.Session`.
  - `Transport.OverWire` is gone: `Transport.fromWire(wire)` returns an Effect that listens in the scope it runs in, `Effect<Transport.Listener, never, Scope>`, and stops listening when the scope closes.
  - A session's counters are in `session.stats`: `held`, `kept`, `unheard`, `unanswered`, `rewinds` and `resimulated`.
  - A session says `hz`, as `Driver.run` does for a game of one, where it said `delta`.

  What breaks:

  - `Session.make(game, { delta: 1 / 60, ... })` is `Session.make(game, { hz: 60, ... })`, and `session.delta` is `session.hz`. A hand-made `Driver.Paced` has `hz` for `delta`, and may have a `lead`.
  - `Message.Made` has `hz` for `delta`, and `Drift.Unlike`'s `differ` names `"hz"` for `"delta"`. A message's bytes are laid out otherwise, so a peer of an earlier arcadekit refuses them.
  - `import * as Peer from "arcadekit/net/Peer"` and `Peer.Peer` are `Session.Session` from `arcadekit/net/Session`.
  - `session.rewinds`, `session.resimulated`, `session.kept`, `session.held`, `session.unheard` and `session.unanswered` are `session.stats.rewinds` and so on.
  - `Transport.layer(Transport.fromWire(wire))` is `Layer.succeed(Transport.Transport, { listen: Transport.fromWire(wire) })`, and `transport.close()` is the scope's close. `transport.dropped` is gone.
  - `Transport.connect` takes a whole `Session.Session`, and `Transport.Connected<E, HU>` takes the app's handlers as its second parameter, as a session does.

- [#499](https://github.com/lucasthevenet/arcadekit/pull/499) [`249ed59`](https://github.com/lucasthevenet/arcadekit/commit/249ed59aecee67253793852d27849358e45ff4e4) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The page's keyboard warns, through Effect's logger, the first time a key comes whose `KeyboardEvent.code` is none of `Input.KeyCode`, once for each code. Such a key is still not heard, but a code a newer browser sends that the list does not have yet is no longer dropped with nothing said. The empty code and `"Unidentified"` are no key, and are not warned of. Nothing breaks.

- [#523](https://github.com/lucasthevenet/arcadekit/pull/523) [`717ba6c`](https://github.com/lucasthevenet/arcadekit/commit/717ba6c66397c33c107699b09704d2026f3c6e4f) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Field.bool` holds `true` or `false`, where a game wrote `Field.u8` and compared with 1. It reads and writes as a boolean in `each`, `world.get`, `set`, `of`, a singleton and `app.inspect()`, and is 1 or 0 in the `Uint8Array` that `eachChunk` hands out. A snapshot and the hash take it for a `Field.u8`, so a save written while the field was a `Field.u8` loads with no migration. `FieldDef` has a `bool` property, true for `Field.bool` alone, and `ComponentDef` a `bools` property, the names of its `Field.bool` fields.

  Nothing breaks.

- [#503](https://github.com/lucasthevenet/arcadekit/pull/503) [`aa4912e`](https://github.com/lucasthevenet/arcadekit/commit/aa4912edbc38bd7c049afa0e25580205912234ce) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A `json`, `ref` or `schema` field is made with its initial value, `Field.json<string>("")`, `Field.ref(codec, initial)` and `Field.schema(schema, initial)`, and a component spawned or added bare holds it there. A bare component read `undefined` in such a field while its type said `T`, and a bare `ref` or `schema` field made the hash throw and the snapshot refuse. `Grid.tiles(width, height)` holds a map of every tile 0 in a bare component.

  **Breaking**

  - `Field.json<T>()`, `Field.ref(codec)` and `Field.schema(schema)` with no initial value don't compile. Write `Field.json<string>("")`, `Field.ref(codec, value)` and `Field.schema(Schema.Date, new Date(0))`. A singleton's fields are given one too, though the singleton's own `initial` is what it holds.
  - A component with such a field and no `initial` of its own has a `ComponentDef.initial` made of its fields' initial values, where it was undefined. A singleton's `ComponentDef.initial` is the singleton's initial value.

- [#264](https://github.com/lucasthevenet/arcadekit/pull/264) [`10917fd`](https://github.com/lucasthevenet/arcadekit/commit/10917fdda5e2e579baaa39fcf567235ecdd252b9) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - What a game played on several machines needs is a folder of modules, `arcadekit/net`, as Effect lays out its own: `import { Session, Transport } from "arcadekit/net"`, and each module as an entry of its own, `arcadekit/net/Session`. A game with one player loads none of it, and a relay server imports `arcadekit/net/Relay` and no session with it.

  What breaks:

  - `Session`, `Transport` and `Relay` are no longer exported by `arcadekit`: import them from `arcadekit/net`. The entries `arcadekit/Session`, `arcadekit/Transport` and `arcadekit/Relay` are `arcadekit/net/Session`, `arcadekit/net/Transport` and `arcadekit/net/Relay`.
  - `arcadekit/Netcode` is gone, split by what it held: `Netcode.Message`, `Netcode.Issued`, `Netcode.encode` and `Netcode.decode` are `Message`'s, `Netcode.Drifted` is `Drift.Drifted`, and `Netcode.Peer` is `Peer.Peer`, all from `arcadekit/net`.

  How peers find that they have drifted apart is a value of its own, `Drift.make({ peer, peers, start })`, which a session's peer tells what it takes and what it hears. It behaves as it did inside the peer, and nothing breaks by it.

- [#355](https://github.com/lucasthevenet/arcadekit/pull/355) [`8feb2cc`](https://github.com/lucasthevenet/arcadekit/commit/8feb2ccae37021134e67b701307d5dfc634e6a87) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - What only a page can use is a folder, `src/browser/`. `arcadekit/Browser` is its `Browser.ts`, and the page's sound is a module of its own beside it, `arcadekit/browser/Audio`: `Audio.layerSound`, `Audio.stream`, `Audio.sound`, `Audio.AudioLike` and `Audio.MediaLike`. What both keep to themselves is in `src/browser/internals/`, which is no entry.

  Nothing breaks: `arcadekit/Browser` exports the same names, with the same types and doc comments, the page's sound among them, and does what it did. `arcadekit/browser/Audio` only adds an entry.

- [#332](https://github.com/lucasthevenet/arcadekit/pull/332) [`95f21d9`](https://github.com/lucasthevenet/arcadekit/commit/95f21d9c01debf4bd355b0fe56c3beeee89de62f) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `app.frame()`, `app.frameExit()` and a `Session.syncTest`'s `frame()` take their `alpha` as optional, and run without one at an `alpha` of 1: a game stepped by hand is drawn where its last tick left it, including a kind of `@arcadekit/three` drawn with `smooth`, which `app.frame(0)` draws where it was a tick before. Nothing breaks: a call with an `alpha` does what it did.

- [#260](https://github.com/lucasthevenet/arcadekit/pull/260) [`ef36674`](https://github.com/lucasthevenet/arcadekit/commit/ef3667454ae5ca6ae10ba58271dacd9e7f5d4bc9) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game is a value, and an app is one run of it. `App.define({ plugins, systems, handlers, version, migrations })` says what the game is, which is the same every time it is played, and `App.make(game, start)` starts a run of it: from a `seed`, or from a `save`.

  What breaks:

  - `App.make(options)` is `App.make(App.define(options), start)`. `seed`, `checkpointEvery` and `verifyFrames` are no longer among a game's options: they say how a run starts, and are `App.make`'s second argument.
  - `App.load(save, options)` is gone: `App.make(game, { save })` continues a saved game. A `save` and a `seed` given together don't typecheck, and are refused with what to give instead.
  - `App.run` is `Driver.run`, and takes the effect that makes the app, not yielded: `App.run(options, { hz, save })` is `Driver.run(App.make(game, { save }), { hz })`. How a run starts is said once, to `App.make`, and what steps an app is all in `arcadekit/Driver`.
  - `App.run`'s `ready` is gone, and so is `App.RunOptions`: `Driver.run`'s options are `Driver.StepOptions`. What `ready` did is a step of the effect that makes the app, `App.make(game).pipe(Effect.tap((app) => ...))`, and what it acquires is still released with the app.
  - A version that isn't a whole number from 0 up is refused by `App.define`, where the game is written, and no longer when its first app is made.

  `arcadekit/Build` is a new entry: what puts an app together, which `App.make` calls.

- [#248](https://github.com/lucasthevenet/arcadekit/pull/248) [`f071651`](https://github.com/lucasthevenet/arcadekit/commit/f0716512e30bd36fdc48ced09371d1deeb742233) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game's log, its recording and its replay are a module of their own, `arcadekit/Journal`, where they were part of `App`. An app still keeps the log and makes the recording: `app.actionLog`, `app.record()` and `app.checkpoint()` are where they were.

  **Breaking**

  - `App.replay(app, recording)` is `Journal.replay(app, recording)`.
  - `App.Recording` is `Journal.Recording`.
  - `App.encodeRecording` and `App.decodeRecording` are `Journal.encode` and `Journal.decode`.
  - `App.HashMismatch` and `App.ReplayDiverged` are `Journal.HashMismatch` and `Journal.ReplayDiverged`.
  - A message that began `App.replay was given` begins `Journal.replay was given`.

- [#458](https://github.com/lucasthevenet/arcadekit/pull/458) [`0b33306`](https://github.com/lucasthevenet/arcadekit/commit/0b333063795fb0e8c2a74b649c4687a2b00a22a1) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/Grid` is a new entry, for a game on tiles. `Grid.tiles(width, height)` is a field that holds a map, a `Grid.Tiles` of a number from 0 to 255 a tile, made by `Grid.fill` and changed into a new map by `tiles.with(x, y, value)`, so a save holds it, the hash covers it, and a refused action puts it back. `Grid.occupants(tiles, view)` works out who is on each tile from a query whose first term has an `x` and a `y`, and keeps nothing, so it is true after a move, a rewind and a load. `Grid.sides` is the four steps to the tiles beside one. Nothing breaks.

- [#505](https://github.com/lucasthevenet/arcadekit/pull/505) [`6ab5c56`](https://github.com/lucasthevenet/arcadekit/commit/6ab5c564bf7c0554bde0220adfca3fbea754ee39) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A key that is down when a control is bound to it moves the control only from its next press. The player who presses K in a rebind menu and still holds it when the menu closes doesn't jump: the jump stays up until K is let go and pressed again. This holds for a button, an axis and a stick, and for a rebind from an input system, a frame system or `Input.settingsOf`. A key the control was already bound to the same way counts as it did, so adding a key to a held button doesn't release it.

  **Breaking**

  - `Input.rebind` and `Input.settingsOf(app, Controls).rebind` onto a key that is down at the next sample no longer press the control at that sample. A game that relied on the press asks the player to press the key again.
  - An input system that reads a control after another input system rebinds it in the same sample reads the bindings that sample began with, as `Input.rebind` says. The new bindings count from the next sample. Before, it read the new bindings at once.

- [#521](https://github.com/lucasthevenet/arcadekit/pull/521) [`bec034f`](https://github.com/lucasthevenet/arcadekit/commit/bec034f86adf211c244d7bf5cab1d4001bdbd891) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - An accessor that `each` or `single()` handed out throws, naming the component and field, when it is read or written after the world's entities changed: a spawn, a despawn, an add or a remove, as commands make when they are applied, and a restore or a rewind. Before, it read and wrote the row it was handed out for, which by then could be another entity's, or a column the table no longer used, and nothing said so. Its getters and setters check nothing: the change points a kept accessor at a column that refuses, so a loop costs what it did.

  **Breaking**

  - An accessor kept past a change of the world's entities throws where it read and wrote. Keep the entity's id and read it again with `world.get`, or call `single()` again, as a system does every tick; or queue the change on `Commands`, so it is made once the accessor is no longer used.

- [#330](https://github.com/lucasthevenet/arcadekit/pull/330) [`ca21988`](https://github.com/lucasthevenet/arcadekit/commit/ca2198831b342f3efe991998cee88e66a08d3e08) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A plugin's `layer` reads the game and cannot change it. A layer is built again when a save is loaded, so what it spawned was in the save and spawned a second time. A layer that requires `Commands`, `World.writes`, a query that writes or `Sim` doesn't compile now, and the error says to spawn in the plugin's `setup`, which a load does not run.

  **Breaking**

  - A layer that spawned or wrote a component moves that work to the plugin's `setup`. What the layer returned of what it spawned, such as a `Spawned` id, is found from the world instead, with a query.

- [#494](https://github.com/lucasthevenet/arcadekit/pull/494) [`98616eb`](https://github.com/lucasthevenet/arcadekit/commit/98616eba74c3279b29d65abf8885ed503ea7fdf4) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game that spawns or adds a `Timer.Lifetime` and leaves out `Timer.plugin` no longer compiles: `App.make` requires `Plugin.Installed<"arcadekit/Timer">`. Before, it ran, and the entity was never despawned. Every plugin provides `Plugin.Installed` of its own name, and `Plugin.KeptBy` marks a component that only one plugin acts on, so that `Commands.spawns` asks for that plugin.

  **Breaking**

  - A game whose commands name `Timer.Lifetime` in `Commands.spawns` lists `Timer.plugin` among its plugins, itself or through one of them.
  - `Plugin.ProvidedOf` of a plugin also holds `Plugin.Installed` of its name, unless the compiler knows that name only as `string`.

- [#350](https://github.com/lucasthevenet/arcadekit/pull/350) [`9bdd5bd`](https://github.com/lucasthevenet/arcadekit/commit/9bdd5bd7d57430fa7877c962f0f247eac0721845) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A list of systems, handlers or plugins that isn't written out as a tuple doesn't compile. The compiler can't read the names or the order of a list typed as an array, so `App.define` and `Plugin.make` let such a list skip the check for a duplicate name and the check for a watcher listed ahead of its writer. A duplicate was then refused only when the app was made, and a misordered list ran a tick late with no error. Now the list is refused with: "List systems, handlers and plugins as a literal list, [a, b], so the compiler can read their names and order." `System.Misordered` and `System.Duplicated` say the same of such a list.

  **Breaking**:

  - A list typed as an array, such as `const systems: readonly System.System<never, BuiltIn>[] = [Move, Draw]` or one made with `Array.from` or `.map`, no longer compiles where `App.define` or `Plugin.make` takes it. Write the list out where it is given, or keep it in a tuple:

  ```ts
  // Before
  const systems = [Move, Draw];
  App.define({ systems });

  // Now
  App.define({ systems: [Move, Draw] });
  // or
  const systems = [Move, Draw] as const;
  App.define({ systems });
  ```

  - A function that takes a list and forwards it to `App.define` no longer compiles, since the compiler can't read a list it only knows as a type parameter. Take the game instead, as an `App.Game`, and call `App.define` where the list is written.
  - A list that is spread from an array, `[Move, ...more]`, is not a tuple either.

- [#468](https://github.com/lucasthevenet/arcadekit/pull/468) [`8994d25`](https://github.com/lucasthevenet/arcadekit/commit/8994d255de000bc0e2d091a067654008104730fb) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A lobby, `arcadekit/net/Lobby`: peers that know only a room meet there before the game begins, and agree on who plays, a seed and the game's settings. `Lobby.join({ me, players, settings })` listens on the program's transport, `lobby.set` and `lobby.ready()` say what this peer wants, `yield* lobby.start` succeeds with `{ me, others, seed, settings }` for `Session.make`, and `lobby.connect(session)` connects the session over the lobby's channel. Each peer gives a part of the seed, and the seed is a hash of every player's part and the settings, so peers that begin otherwise stop as `Drift.Drifted` before a tick they are sure of. A peer the players began without fails with `Lobby.Full`.

  What is not the game's goes between peers as a `Message.Aside`, written by `Message.encodeAside` and read by `Message.decodeAside`. `Relay.forward` passes one on as it passes on a message, and refuses one in another peer's name. `Transport.connect` drops one.

  What breaks:

  - A `Transport.Listener` sends a `Message.Message` or a `Message.Aside`, and `receive` returns asides too. A listener written by hand that reads what it receives tells an aside by its `topic`.
  - `Message.Invalid`'s `problem` may be `"not an aside"`.
  - A relay of an earlier arcadekit refuses an aside as `"not a message"`.

- [#462](https://github.com/lucasthevenet/arcadekit/pull/462) [`40201e8`](https://github.com/lucasthevenet/arcadekit/commit/40201e893dad0297ed87801d3eae25625e6d1097) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - What a frame or an input system keeps from one frame to the next, such as a camera's angle or when a HUD was last shown, has a home: `const Orbit = System.local(() => ({ angle: 0 }))`, and `(yield* Orbit).angle += delta` in the system. Each app has its own value, made the first time one of its systems yields the local and passed to `System.local(make, release)`'s `release` when the app closes, so two apps of one game share nothing, as two apps sharing a variable of a module did. Every system that yields one local shares its value, so an input system can set what a frame system, or the condition of `Assets.during`, reads. The value is outside the world: a save, the hash and a rewind leave it as it is. A system of the tick, a hook, a handler or a plugin's setup that yields a local doesn't compile, since what the tick keeps belongs in the world.

  Nothing breaks. `Services.BuiltIn` includes `System.Locals`, the service the app provides to its frame and input stages. The Three.js example page keeps its camera, its HUD and whether its deck is out in locals, and reads the C key in the input stage where it listened to the page.

- [#351](https://github.com/lucasthevenet/arcadekit/pull/351) [`d2ad7f1`](https://github.com/lucasthevenet/arcadekit/commit/d2ad7f1dfb52894537da48cf048c2c3d572e6b47) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A component's name is a literal the compiler reads, and only `Query` makes the description `world.view` takes. A name known only as `string` and a query description written by hand both compile no more, where each was refused at run time, if at all.

  **Breaking**

  - `Component.define`, `Component.tag` and `Component.relation` take a name the compiler reads: `Component.define("game/Hero", schema)`, or a template such as `` `game/Tag${n}` ``. A name typed `string` doesn't compile, and the error says to write a literal.
  - `world.view` takes only a `Query`. An object written as `{ terms, withDefs, withoutDefs }` doesn't compile: write `Query.all(...terms).pipe(Query.without(...), Query.writes(...))`. `QuerySpec` stays exported, as the type of what `world.view` takes.
  - `world.view` no longer checks that `readDefs` are among the terms, since `Query` makes them from its terms.

- [#324](https://github.com/lucasthevenet/arcadekit/pull/324) [`43ea5c0`](https://github.com/lucasthevenet/arcadekit/commit/43ea5c04a76539b0392fe35ccc3b3277361c2b19) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Relay.join` takes the name the host proved the asking peer holds, and refuses a peer whose address asks for another with `"not your name"`. A host can no longer let a peer in without saying who may use a name: it passes the name its own check of the request established, or `Relay.anyone` to let anyone take any free name.

  **Breaking**

  - `Relay.join(url, present, options)` is `Relay.join(url, proven, present, options)`: `Relay.join(request.url, playerOf(request), present)`, or `Relay.join(request.url, Relay.anyone, present)` for a relay that proves nothing.
  - `relay.connect(url, send)` is `relay.connect(url, proven, send)`.
  - `Relay.Refused["reason"]` has one more case, `"not your name"`.

- [#500](https://github.com/lucasthevenet/arcadekit/pull/500) [`9380d16`](https://github.com/lucasthevenet/arcadekit/commit/9380d166636b438241f6c076a49f6cfe9e0663ea) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game that plays from a cue sheet its page wasn't given doesn't compile. A frame-stage system asks for a sheet's sounds with `yield* Sound.Clips(Sfx)`, and its type then requires `Sound.Plays<"game/Sfx">`, which only what says where the sound goes provides. A page provides it for each sheet in its `sounds`, of `Browser.runMain`, `Browser.layer` or `Audio.layerSound`, so a page missing one is a compile error that names the sheet. `Sound.layer(speaker)` and `Test.make` provide it for every sheet, as a recorder records any, and so does the new `Sound.layerNowhere`, by which sound goes nowhere, for a server or a replay. `Sound.cues(name, Sfx, (sounds) => lines)` builds a cue system from a sheet's sounds, as it does from a bundle's.

  **Breaking**

  - A sheet's sounds are no longer its properties. `Sound.on(Scored, Sfx.coin)` in `Sound.cues(name, ...lines)` is now `Sound.cues(name, Sfx, ({ coin }) => [Sound.on(Scored, coin)])`, and a music body or a frame system asks for them: `const { theme } = yield* Sound.Clips(Tracks)`. `Sound.Sheet` is a class, `Sound.Sheet<"game/Sfx", "coin" | "thud">`, where it was the record of its clips.
  - A program that runs a game whose systems play from a sheet says where its sound goes. A page lists every such sheet in `sounds`, a stream's sheet too, and a server, a replay or a test that made its app with `App.make` and provided no `Sound.layer` provides `Sound.layerNowhere`.
  - `Browser.layer` and `Audio.layerSound` give the type of their sheets, `Layer.Layer<Sound.Plays<"game/Sfx">>`, and `Sound.layer` gives `Layer.Layer<Sound.Plays<string>>`, where each gave `Layer.Layer<never>`.

- [#540](https://github.com/lucasthevenet/arcadekit/pull/540) [`5df4310`](https://github.com/lucasthevenet/arcadekit/commit/5df431085e9d9aebe2cbaa6d6529965fff9e1df4) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Action.define` takes an action's payload beside its error, as `Rpc.make` does: `Action.define("duel/Strike", { payload: Schema.Struct({ ... }), error: NotYourTurn })`.

  **Breaking**

  - The payload's schema moves from the second argument into `payload`. `Action.define("duel/Strike", Strike)` is now `Action.define("duel/Strike", { payload: Strike })`.
  - An action with an error and no payload leaves out `payload`, where it gave `Schema.Void`: `Action.define("duel/Pass", { error: Tired })`.

- [#322](https://github.com/lucasthevenet/arcadekit/pull/322) [`6be34e3`](https://github.com/lucasthevenet/arcadekit/commit/6be34e39948e989a41f29e9faaab454cbf357db1) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A peer that leaves and never comes back no longer stalls the game for ever. `Transport.connect(session, { awayFor })` waits for a peer the relay said left for `awayFor` milliseconds of the connection's ticks, 60,000 by default. Then the tick throws `Transport.Left`, with the `peers` that stayed away, and the driver stops, as it does for `Transport.Closed`.

  What breaks: a game whose peer is away for more than a minute now stops with `Transport.Left` where it used to wait. Pass `{ awayFor: Infinity }` to wait for ever.

- [#474](https://github.com/lucasthevenet/arcadekit/pull/474) [`7b81085`](https://github.com/lucasthevenet/arcadekit/commit/7b81085bf69d83bb4088db62c29cfdc6b6ac1130) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A lobby's player says what it began with as it begins, and again whenever a peer speaks in the lobby or joins the room, for as long as its connection is open. A peer that lost the first saying, because a socket dropped, begins with the same names, seed and settings once the two hear each other again, where it waited in the lobby, or failed with `Lobby.Full` though it was a player. A peer that hears a player's session before what the player began with asks for it, and fails with `Lobby.Full` only when the player began without it. Nothing breaks.

- [#475](https://github.com/lucasthevenet/arcadekit/pull/475) [`6026e50`](https://github.com/lucasthevenet/arcadekit/commit/6026e50cb71e62451d935c8cb71d23d3f9eabf37) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A frame system sees each press and release of `Input.Keyboard`, `Input.Pointer` and `Input.Gamepad` once, in the first frame drawn after its tick. Before, `pressed` compared with the game's tick, so it was true on every frame until the next tick, and a frame of two ticks missed a press in the first: a page that draws at 144 Hz over 60 ticks toggled a menu two or three times for one key. The app keeps which ticks no frame has drawn yet, and the frame stage reads `pressed` and `released` against them. After `Timeline.rewind`, the ticks run again are new to the frame stage, as their events are. After a rewind with `{ again: true }`, as a rollback session makes on a wrong prediction, a press the last frame showed isn't shown again, and one that only the ticks run again have is shown once. After `Save.load`, what the save holds of before its tick isn't shown. A tick, an action's handler and the input stage read them as before.

  **Breaking**: the world keeps every button that has been down, with the ticks it last went down and up in, where it forgot a button at the first report after the tick it went up in. The hash now holds a button that went up long ago, so a game in which a key was pressed and let go hashes differently from one in which it never was, and a recording made before this release whose hash checks follow a release of a key fails `Replay.verify` with `Replay.Diverged`. The save format stays 4: a save from before, of format 3 or 4, loads as it was, holding the buttons down and those let go in its last tick, and the game keeps every button that goes down from then on.

- [#287](https://github.com/lucasthevenet/arcadekit/pull/287) [`b9c182a`](https://github.com/lucasthevenet/arcadekit/commit/b9c182ad574a17ed1afd1aa88d5a0d7dd64879ec) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A query that is put together wrong doesn't compile. `Query.writes` takes only the query's own terms, and a query that watches a component with `Query.changed` and writes it with `Query.writes` has no `eachChunk`. Both were refused at run time before, when the path ran. Each error names the component and says what to write instead.

  **Breaking**

  - `Query.all(Position).pipe(Query.writes(Velocity))` doesn't compile. Add `Velocity` to `Query.all`, or require it without its data with `Query.with(Velocity)`. A component the compiler knows only as a `ComponentDef` is still refused when it is given.
  - `eachChunk` on a query made with `Query.changed(Position)` and `Query.writes(Position)` doesn't compile, in a frozen world too, where it was allowed before. Visit it with `each`, or leave `Position` out of `Query.writes` if the loop only reads it. A query description written by hand and passed to `world.view` is still refused when `eachChunk` runs.

- [#491](https://github.com/lucasthevenet/arcadekit/pull/491) [`0adb1e0`](https://github.com/lucasthevenet/arcadekit/commit/0adb1e0e9c28ac484e3b8fea198984df4883949c) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `commands.despawning(entity)` returns whether an entity is queued to despawn, and so does `CommandBuffer.despawning` of `arcadekit/ecs`. `Overlap.pairs` asks it before each pair, so an entity queued to despawn takes part in no later pair of the call, however it was queued: by what the callback returns, by `commands.despawn` in the callback, or before the call. A bullet that the callback despawns itself hits once.

  **Breaking**

  - The commands that `Overlap.pairs` takes have a `despawning` beside `despawn`. The app's `Commands` and a `CommandBuffer` have both. A stand-in of a game's own adds `despawning: () => false`.
  - A class or object that implements `Spawning` itself adds `despawning`.

- [#387](https://github.com/lucasthevenet/arcadekit/pull/387) [`3938a54`](https://github.com/lucasthevenet/arcadekit/commit/3938a543e015b593515cf4d27d0a2e2081bb54d8) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Messages and recordings are written in bytes, with Effect's `SchemaBinary`, instead of JSON text. `Message.encode` returns a `Uint8Array` and `Message.decode` takes one. `Journal.encode` and `Journal.decode` do the same, and a recording holds its save as the bytes `Save.encode` writes, not in base64. `Message.Message` is now a schema, and the `Message`, `Issued` and `Made` types are what it holds, so the type and what is checked on the wire are one definition. A relay forwards the bytes a member sent, unchanged, once it has checked them. Measured on a two-peer game of 600 ticks, its messages take 55% fewer bytes, its recording 35% fewer, and one since a save 30% fewer.

  What breaks:

  - Messages and recordings written by an earlier version are not read: `Message.decode` and `Journal.decode` refuse text. A peer of an earlier version can't play with one of this version, and a relay of either refuses the other's messages.
  - A message is a binary frame and a relay's notice is still a text frame. What carries them tells the two apart. A host that hands `Relay.forward` or `connection.receive` a message as a string is refused with `"not a message"`: pass binary frames as their bytes.
  - `Relay.Delivery` has `data: string | Uint8Array` in place of `text`, and `Server.connect`'s `send` takes the same. Send `data` as it is, so a message goes out as a binary frame.
  - `Relay.Options.maxLength` counts bytes, not characters.
  - `Transport.text` is `Transport.fromWire`, and `Transport.TextTransport` is `Transport.WireTransport`. A `Wire` sends a message's bytes, `send(bytes: Uint8Array)`, and hands `listen` each frame as it came, a `Uint8Array` or a string.

- [#261](https://github.com/lucasthevenet/arcadekit/pull/261) [`f528900`](https://github.com/lucasthevenet/arcadekit/commit/f528900240d5760de79d2fdac830c48b4530569d) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A recording holds how its game began, and a replay hands that to what makes its app. `app.record()` returns the game's `seed` with its log, or the `save` it was recorded since, in the words `App.make` takes. `Journal.replay(recording, (start) => App.make(game, start))` makes the app from that start, so a replay can't be given the wrong seed, plays the recording in it and returns it where the recording ends.

  What breaks:

  - `Journal.replay(app, recording)` is `Journal.replay(recording, (start) => App.make(game, start))`: it takes the recording and a function that makes the app from how the recorded game began, and is an effect itself. A game that made its app with `{ seed }` and replayed into it now makes it from `start`.
  - A replay that diverges fails with `Journal.ReplayDiverged` in the effect's error channel, and no longer throws it. To look at the app a replay stopped in, keep it in the function that makes it, with `App.make(game, start).pipe(Effect.tap((app) => ...))`.
  - `Journal.Recording` has a `seed` or a `save`, one of the two. A recording built by hand needs one, and `Journal.decode` refuses text without one: recordings encoded before this don't decode.
  - A recording made with `app.record(save)` holds that save, so its text from `Journal.encode` is longer by the save. Replaying it needs no `App.make(game, { save })` first: `Journal.replay(tail, (start) => App.make(game, start))`.
  - An app made from a save keeps the save for as long as it lives, to record from.

- [#325](https://github.com/lucasthevenet/arcadekit/pull/325) [`38d46bd`](https://github.com/lucasthevenet/arcadekit/commit/38d46bd845b05c7f3e4341309b10c8ba99879491) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Migrate.renameComponent` renames the component's entries under `Save.VISITS` too, with the change queries that name it. After the load, a change query on the renamed component goes on from where it was, instead of visiting every entity again, and an `added` query no longer reports every entity with the component as added.

  **Breaking**

  - A game that counted on a renamed component's change queries starting over after a migration now sees only what changed since the save. To visit every entity again, visit them with a query that has no `Query.changed` or `Query.added`.

- [#347](https://github.com/lucasthevenet/arcadekit/pull/347) [`8fc89d0`](https://github.com/lucasthevenet/arcadekit/commit/8fc89d06ee2d3452fc789db9594c19cd91b70057) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A recording holds `endHash`, the world's hash where it ends, and `Journal.replay` compares it once the last tick has run, whatever `checkpointEvery` was. A replay that succeeds ended on the world the recorded game ended on. Only `app.record()` and `Journal.decode` make a `Journal.Recording`.

  **Breaking**

  - `Journal.Played`, and so `Journal.Recording`, has a new field, `endHash`.
  - `Journal.Recording` is branded: an object literal no longer compiles as one. A test that wrote a recording by hand takes `app.record()`, and one that edits a recording edits its text and reads it back with `Journal.decode`.
  - `Journal.decode` refuses a recording that an earlier version wrote, with no `endHash`, with a message that begins `older format`. Record it again.
  - A replay of a recording made with `checkpointEvery: 0`, or of one whose last checkpoint is before its end, that ends on another world fails with `Journal.ReplayDiverged`, where it succeeded. Its `entry` is a checkpoint of the recording's `end` and `endHash`, and its `index` is the log's length.
  - `Journal.replay` no longer throws on a recording whose `start` isn't where its seed or save begins, or whose first run of deltas doesn't begin at its `start`, and no longer fails with "was never reached" for a log past the recording's end. `Journal.decode` refuses all three, and only it and `app.record()` make a recording.

- [#295](https://github.com/lucasthevenet/arcadekit/pull/295) [`398f410`](https://github.com/lucasthevenet/arcadekit/commit/398f410857603233253af43723dfd667933182e2) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Journal.replay` takes the game and makes the app itself, from how the recording says its game began, so a replay can't begin anywhere else. Its options are the rest of what `App.make` takes, `Journal.ReplayOptions`, which has no `seed` and no `save`. A replay that diverges fails with a `Journal.ReplayDiverged` that holds the replay's app, `diverged.app`, where it stopped.

  **Breaking**

  - `Journal.replay(recording, (start) => App.make(game, { ...start, checkpointEvery: 1 }))` is `Journal.replay(recording, game, { checkpointEvery: 1 })`, and `Journal.replay(recording, (start) => App.make(game, start))` is `Journal.replay(recording, game)`. A `seed` or a `save` in the options doesn't compile.
  - The app to look at when a replay has stopped is no longer kept with `Effect.tap` in the function that made it. It is the error's: `Effect.catchTag("ReplayDiverged", (diverged) => diverged.app.read(World))`.
  - Code that made its app some other way than from the start it was handed, or prepared it before the replay began, has no place to do so. A game whose systems call an app they keep in a variable enqueue through `Action.Actions` instead, which is the same move from inside the simulation.
  - `Journal.ReplayDiverged` has a type parameter, the app, and an `app` field.
  - The refusal of an app that isn't where the recording begins is gone, with the function that could make one. A recording built by hand whose seed or save doesn't begin where it does is still refused when it is replayed, as `Journal.decode` refuses its text.

- [#471](https://github.com/lucasthevenet/arcadekit/pull/471) [`b788248`](https://github.com/lucasthevenet/arcadekit/commit/b78824872d0a8927a660a8c64a84ac7dc35b43eb) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A recording can be watched, at its own pace, in a page: `Replay.play(recording, game)` makes a player, which `Driver.run` steps a recorded tick at a time and draws, and which pauses, goes faster and goes to any tick. And each thing a game is kept as has one name: a moment, a save, a recording, a snapshot and a hash check.

  ```ts
  Driver.run(Replay.play(recording, Duel), {
    ready: (player) => Effect.andThen(player.play(2), player.seek(1200)),
  });
  ```

  `Journal` is `Replay`, and taking a save, a recording or a hash check is a function, as capturing a moment is.

  **Breaking**

  - `arcadekit/Journal` is `arcadekit/Replay`. `Journal.replay(recording, game)` is `Replay.verify(recording, game)`, `Journal.ReplayDiverged` is `Replay.Diverged`, whose tag `"JournalReplayDiverged"` is `"ReplayDiverged"`, and `Journal.ReplayOptions` is `Replay.Options`. `Journal.HashMismatch`, `Journal.Invalid`, `Journal.Recording`, `Journal.Origin`, `Journal.Played`, `Journal.encode` and `Journal.decode` are `Replay`'s, and the tags `"JournalHashMismatch"` and `"JournalInvalid"` are `"ReplayHashMismatch"` and `"ReplayInvalid"`.
  - A checkpoint is a hash check: the option `checkpointEvery` of `App.make`, `Replay.verify` and `Session.make` is `hashEvery`, `Action.Checkpoint` is `Action.HashCheck`, and `Action.isCheckpoint` is `Action.isHashCheck`. A message's `checkpoints` keeps its name, and its bytes.
  - An app's methods for what is kept of it are functions: `app.save()` is `Save.make(app)`, `app.load(save)` is `Save.load(app, save)`, `app.record(since)` is `Replay.record(app, since)`, and `app.checkpoint()` is `Replay.hashCheck(app)`. Their messages when called where they may not be name the functions.
  - A save no longer holds the length of the log that made it: `Save.Save` has no `logLength`. The app knows where each save it made is in its log, so `Replay.record(app, save)` takes a save the app made, or the one it was made or loaded from, and dies for any other. A save is written in format 4, and one in format 3 is still read.

- [#496](https://github.com/lucasthevenet/arcadekit/pull/496) [`01c6a8b`](https://github.com/lucasthevenet/arcadekit/commit/01c6a8b7bc72492d08f5dd60a078b0ce785f1fcb) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Replay.record(app, save)` knows a save by what it holds, so a copy read back from its bytes, as `Save.read` gives one from a slot, starts a recording.

  ```ts
  Effect.gen(function* () {
    const saved = yield* Save.read("auto");
    return yield* Replay.record(app, Option.getOrThrow(saved));
  });
  ```

  **Breaking**

  - `Replay.record(app, save)` dies for a save its app's log no longer reaches: one taken before the app loaded a save in place, or one the game went back to before, with `Timeline.rewind` or `Timeline.undo`, and came to again past a move or a tick of another length, the same moves as before included. It recorded such a save when the ticks of the log happened to agree with it, and the recording replayed right only when the moves were the same. Record since a save taken after the load or the rewind, or record all of it.
  - In a session that runs ahead, a save of a tick that wasn't final dies once a late move rolls the game back past it, even when the game comes to the same save again, which it recorded before. Record since a save taken at a tick no later than `session.confirmed`, or record all of it.

- [#297](https://github.com/lucasthevenet/arcadekit/pull/297) [`e2eb0c4`](https://github.com/lucasthevenet/arcadekit/commit/e2eb0c4f3279d1f89ea707b7c93980ac67939663) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A session is told how long a tick is once, by its `delta`. `session.tick()` and `session.tickExit()` take no delta, and a driver given a session, or a session connected to a transport, ticks it `1 / delta` times a second: `Driver.frames(yield* Transport.connect(session))`. `fixedStep`, `interval`, `frames` and `run` have a signature for a session, which takes neither `hz` nor `ticks`, so a driver at another rate than the session's and a session that rests with `ticks: "whenNeeded"` don't compile, and the error says why. `Driver.Paced` is what ticks by a `delta` of its own, and `Driver.PacedOptions` what a driver given one takes: `maxStepsPerCall`.

  **Breaking**

  - Replace `Driver.frames(connected, { hz: 60 })` with `Driver.frames(connected)`, and the same for `fixedStep`, `interval` and `run`. A session given `hz` or `ticks` no longer compiles, where a rate other than `1 / delta` threw at its first tick.
  - `session.tick(delta)` and `session.tickExit(delta)` are `session.tick()` and `session.tickExit()`, and `Transport.Connected`'s `tick` takes no delta.
  - `Transport.connect` takes the session's `delta` too, and `Transport.Connected` has it. `Peer.Peer` and `Transport.Connected` extend `Driver.Paced`, not `Driver.Tickable`.
  - `Driver.Tickable` has `delta?: never`: a tickable with a `delta` of its own is a `Driver.Paced`.

- [#489](https://github.com/lucasthevenet/arcadekit/pull/489) [`2e95176`](https://github.com/lucasthevenet/arcadekit/commit/2e95176e32490fa5405a97213826cb7bae78538f) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Reading a setting fails with `Setting.Invalid`, naming its key, when what the store kept isn't JSON or the setting's schema no longer takes it, where it gave the initial value and said nothing.

  **Breaking**

  - A `Setting<A>` is an `Effect<A, Setting.Invalid, Setting.Store>`, where its error was `never`. A system that reads one can fail with `Setting.Invalid`, and so can the app's frame and input stages and `Driver.run`, which ends with it. A game that would rather start from the initial value reads the setting with `Effect.orElseSucceed`:

  ```ts
  Effect.gen(function* () {
    const volume = yield* Effect.orElseSucceed(Volume, () => Volume.initial);
  });
  ```

- [#490](https://github.com/lucasthevenet/arcadekit/pull/490) [`23874b0`](https://github.com/lucasthevenet/arcadekit/commit/23874b09f6ee43bedcb353599008d99ebb4d7f71) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game's UI can tell whether an autosave kept the game. `Save.slot(name)` names a slot, and in a frame or input system `yield*` of it returns its status: `Off` when nothing autosaves the app, `Unasked`, `Saved`, or `Failed` with `Save.Refused` or `Save.StoreFailed`. `Save.match` gives a case for each:

  ```ts
  const Auto = Save.slot("auto");
  const Saved = View.define("game/Saved", { label: "" });

  const ShowSaved = View.publish(Saved, function* () {
    return {
      label: Save.match(yield* Auto, {
        Off: () => "",
        Unasked: () => "",
        Saved: () => "Saved",
        Failed: ({ error }) => `Not saved: ${error.message}`,
      }),
    };
  });
  ```

  The status is outside the world, as a setting is: the hash, the log and a save don't hold it, and the code of the tick can't read it. A failed autosave is still logged as an error, and a store that throws in place of failing now counts as `Save.StoreFailed`.

  Nothing breaks.

- [#366](https://github.com/lucasthevenet/arcadekit/pull/366) [`b3e03a3`](https://github.com/lucasthevenet/arcadekit/commit/b3e03a3e8d1f0efcf238d231a5aaa2680fda268e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Transport.layerWebSocket` is carried over the `Socket` of `effect/socket`, and connects again on a `Schedule`. It opens its sockets with the `Socket.WebSocketConstructor` that is provided, such as `NodeSocket.layerWebSocketConstructor` of `@effect/platform-node`, and with the standard `WebSocket` when none is. Its waits run on Effect's `Clock`, so a test can drive them with `TestClock` against a stub socket. A socket that has not opened after 10 seconds counts as one that could not connect, and a binary frame is read as UTF-8 text, where it was dropped.

  Nothing breaks: the layer's signature, its options and `Transport.Closed` are the same, and so are the waits between tries, 50 ms doubling up to two seconds.

- [#267](https://github.com/lucasthevenet/arcadekit/pull/267) [`92ff42d`](https://github.com/lucasthevenet/arcadekit/commit/92ff42ded98ff31115ca694972be82a5068b74e0) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A socket that drops no longer ends the game. `Transport.layerWebSocket(url, { reconnectFor })` connects again, waiting longer each time, for 30 seconds by default, and buffers what is sent meanwhile; it tries a taken name again while it does, since the relay may not have seen the old socket close. Every message says how far its peer has heard the others, `heard`, and a session keeps what it sent until every other peer has heard it: `session.resend()` returns it, and `session.unheard` counts it. The relay tells a room who joins it and who leaves it, with a `Message.Notice` (`{ joined }` or `{ left }`), from `Relay.joined` and `Relay.left`, which `Relay.make` sends itself. `Transport.connect` sends again what some peer hasn't heard when a peer joins, and lists the peers that left in `connected.away`, so the others know whom they wait for. `Transport.makeHub` has `disconnect(peer)` and `reconnect(peer)`, to test it.

  What breaks:

  - A transport's `receive` returns `Message.Message | Message.Notice`: a hand-made transport that returns only messages still is one, and code that reads `receive` tells the two apart with `"from" in arrived`.
  - A host that calls `Relay.join` and `Relay.forward` itself also sends what `Relay.joined` returns once it has let a member in, and what `Relay.left` returns once its socket has closed. Without them, a peer that comes back is never sent what it missed.
  - `Transport.layerWebSocket` throws `Transport.Closed` only once the socket closes for good: when it never opened, when the relay refused it, or when it could not connect again within `reconnectFor`. With `reconnectFor: 0`, it ends the game as before.
  - `Transport.connect` takes a session with `resend`, which every session has.

- [#256](https://github.com/lucasthevenet/arcadekit/pull/256) [`af22917`](https://github.com/lucasthevenet/arcadekit/commit/af2291704bed03e15758889e7c253ed187dccf62) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - What a game's code is given by the stage it runs in, and how the stages run, are modules of their own. `arcadekit/Stage` builds the services of the tick, of the frame stage and of the input stage. `arcadekit/Loop` runs a tick and the two stages between ticks, and holds the spans of an app that traces. `App.make` uses both as before.

  This breaks one name: `App.FrameChangedWorld` is `Stage.FrameChangedWorld`. Its tag and its message are unchanged.

- [#371](https://github.com/lucasthevenet/arcadekit/pull/371) [`7d71f4a`](https://github.com/lucasthevenet/arcadekit/commit/7d71f4ade2458869a3cbdabeef9c2fd3f56156cc) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A state's name is a literal the compiler reads, as a component's is, so `State.scoped(Phase, "playing")` is typed by the name it has, `"game/Phase.Scoped.playing"`. `Commands.spawns` named with one state's scope no longer lets a system spawn the scope of another state's value of the same name, or of another value of the same state, and the order of a list of systems is checked against the scope a system spawns, not that value of every state.

  **Breaking**

  - `State.define` takes a name the compiler reads: `State.define("game/Phase", values)`. A name typed `string` doesn't compile, and the error says to write a literal.
  - `State` takes its name as a second type parameter, `State<V, N>`, which defaults to `string`.
  - `State.scoped` returns a tag typed ``ComponentDef<{}, "table", `${N}.Scoped.${S}`>``, for the state's name `N` and the value `S` it is given, where it was named `` `${string}.Scoped.${V}` `` for every value `V` of the state. A system that spawns two values' scopes names each in `Commands.spawns`.

- [#345](https://github.com/lucasthevenet/arcadekit/pull/345) [`af2f006`](https://github.com/lucasthevenet/arcadekit/commit/af2f0064f44d4c0f53e2ca6d912596cb1cb7cbab) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `App.Steered`'s `enqueueByName` takes a name and a payload, and no `from`. A session stamps each action with the name of the peer that issued it, so passing `from` on `session.app` doesn't compile, where it threw.

  What breaks: a call to `session.app.enqueueByName(name, payload, from)` with a `from` no longer compiles. That call already threw at run time. Drop `from`, and the session names this peer as the issuer.

- [#352](https://github.com/lucasthevenet/arcadekit/pull/352) [`da22104`](https://github.com/lucasthevenet/arcadekit/commit/da221044bc8aa3f40a2e4c7b8ca70d118b516ead) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A `Field.entity` reads as an `Entity.Ref`, which no call of the world takes, and `world.live(ref)` returns the entity it refers to while that entity is alive, and `undefined` once it is despawned, even after another entity takes its slot. A stale id kept in a field can no longer be passed to `get`, `has`, `set`, `sources` or `Commands` as if its entity were there. `live` is on the world a system is handed, on the one `app.read(World)` hands out, and on `EcsWorld`.

  **Breaking**: a value read from a `Field.entity`, in `each` or from `world.get`, is an `Entity.Ref`, not an `Entity`. Where a game passed it to the world, it now passes it through `live` first:

  ```ts sketch
  // before
  world.get(hunter.target, Health);
  // now
  const target = world.live(hunter.target);
  if (target !== undefined) world.get(target, Health);
  ```

  A field still takes an `Entity`, an `Entity.Ref` or a `Spawned` id as it did. `isAlive`, `entityIndex` and `entityGeneration` take an `Entity.Ref` too.

- [#326](https://github.com/lucasthevenet/arcadekit/pull/326) [`03ddcbb`](https://github.com/lucasthevenet/arcadekit/commit/03ddcbbca8dcce077b898b2a2a99e785f2e1349b) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A frame or input system that requires a `Scope` no longer compiles, as a tick system already did not. It was given the app's scope, so what it opened on each frame, such as a bundle from `Assets.load`, was kept until the app closed, with no error.

  What breaks:

  - A frame or input system that yields `Assets.load`, `Effect.acquireRelease`, `Scope.Scope` or anything else that requires a `Scope` is refused where it is written. A system holds a bundle with `Assets.during` or `Assets.Store`. What lasts as long as the app is opened in a plugin's `layer`.

- [#328](https://github.com/lucasthevenet/arcadekit/pull/328) [`2411d97`](https://github.com/lucasthevenet/arcadekit/commit/2411d97bbc48a1036189cfd2b9c044e49295d3ee) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Transport.layerBroadcastChannel` tells the other peers who joined and who left, as a relay does. It posts a `Message.Notice` that its peer joined when its channel opens, and one that it left when its channel closes. `Browser.runMain` closes the channel when the page is closed for good. So `connected.away` lists a tab that closed, where it stayed empty before.

  **Breaking**

  - `Transport.layerBroadcastChannel(name)` is `Transport.layerBroadcastChannel(name, me)`, with the peer's name as its session has it.
  - Every peer that listens on the same name hears a `{ joined }` and a `{ left }` notice from the others, beside their messages.

- [#286](https://github.com/lucasthevenet/arcadekit/pull/286) [`2a6edb3`](https://github.com/lucasthevenet/arcadekit/commit/2a6edb3cc1ea43db2d190f2440e4d28706662cd7) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A tick reads no device. The input stage runs only when something runs it: a driver before each tick, a session before each of its ticks, or `app.input()` by hand. A tool that re-runs a game from its log ticks it with `app.tick(delta)` alone, and the keys and the UI of the machine it runs on cannot reach the game.

  **Breaking**

  - `app.tick(delta)` and `app.tickExit(delta)` no longer run the input stage when nothing has since the previous tick. A game or a test that steps its app by hand and reads the devices or a `View.Bridge` calls `app.input()` before each tick that is to receive them.
  - `App.TickOptions` and the second argument of `tick` and `tickExit` are removed. Replace `app.tick(delta, { input: false })` with `app.tick(delta)`.
  - The `Action.INTAKE` store of a save and of `app.inspect().stores` is `{ queued }`, no longer `{ queued, heard }`. A save holds no store for it when no action is queued. A save written with `heard` still loads, and `heard` is ignored.

- [#253](https://github.com/lucasthevenet/arcadekit/pull/253) [`34ffc3f`](https://github.com/lucasthevenet/arcadekit/commit/34ffc3fd6aab83561cfd98103bfc06f6f9888dc5) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Capturing a game and putting it back are a module of their own, `arcadekit/Timeline`, and no longer members of an app: a game that never goes back imports none of it.

  This breaks callers of four members and one type:

  - `app.capture()` is `Timeline.capture(app)`, and `app.rewind(moment)` is `Timeline.rewind(app, moment)`.
  - `App.Moment` is `Timeline.Moment`.
  - What `app.divert` returns no longer has `capture` and `rewind`. A session that goes back to run the same ticks again calls `Timeline.rewind(app, moment, { again: true })`, and one that rewinds before the frame and input stages run again captures with `Timeline.capture(app, { stages: true })`.

  The messages of a refused call begin with `Timeline.capture()` and `Timeline.rewind()`, and one made from an action's handler says "an action's handler" without naming the action.

  An app's log is a store of its world, as its events and its queued actions are, so a rewind takes it back with the world.

- [#385](https://github.com/lucasthevenet/arcadekit/pull/385) [`aa2196b`](https://github.com/lucasthevenet/arcadekit/commit/aa2196bc8448752b5749305d4a10175dbc59f124) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `View.publish` runs its body only while the UI watches the view: while the view has a listener, and in the frame after the UI reads it with `get`. A view nobody watches costs the game nothing. `View.publish(view, { when }, body)` runs the body again only when what `when` returns changed, compared as data, and publishes the value it last computed otherwise.

  **Breaking**

  - `ui.get` of a view the UI doesn't listen to returns it a frame late: the frame after the read publishes it. A UI, or a test acting as one, that reads a view after each frame subscribes to it, `ui.subscribe(view, listener)`.
  - `View.PortShape.connected` is gone. A frame system of the game's own that checked it asks `(yield* View.Port).watched(view)`, which is false for every view where there is no UI.

- [#400](https://github.com/lucasthevenet/arcadekit/pull/400) [`fdfd8c0`](https://github.com/lucasthevenet/arcadekit/commit/fdfd8c0458d9d46340d9b4cba42c821527cfd0da) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A singleton read whole can no longer be a view's value. `yield* SomeSingleton` and `World.singleton` return a `Singleton.Read`, the world's own object, which is the same object on every read. Returned whole from `View.publish`'s `when`, or published as a view's value, it never differed from the frame before, so the view kept its first value with no error. A field of it and a spread of it compile as before.

  **Breaking**

  - A `View.publish` body or `when`, or a `View.Port.publish` value, that holds a singleton read whole no longer compiles. That covers the read returned directly, in a union, and inside arrays and objects up to 32 levels deep. Return its fields instead:

    ```ts
    // before
    when: function* () {
      return yield* Score;
    }
    // now
    when: function* () {
      return (yield* Score).points;
    }
    ```

  - `yield* SomeSingleton` and `World.singleton(SomeSingleton)` are typed `Singleton.Read<S>`, not `Readonly<ValueOf<S>>`. A plain object does not pass for one, so a variable of that type has to be assigned a read.
  - `View.publish` and `View.Port.publish` take one more type parameter, for the value they are given. A call that gives its type arguments explicitly gives that one too.

- [#282](https://github.com/lucasthevenet/arcadekit/pull/282) [`3683e37`](https://github.com/lucasthevenet/arcadekit/commit/3683e375396bfc4baab888a71491ced3030e69aa) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The world a system, a handler, a setup or a plugin's layer is handed, and the one `app.read(World)` gives, is one object per app of its own, which reads and sets the world behind it. No check of its class reaches `spawn`, `despawn` or `restore` through it.

  **Breaking**

  - `yield* World` is no longer an `EcsWorld`, so `instanceof EcsWorld` is false. Change the set of entities with `Commands`.
  - `whole` is no export of `arcadekit/Services`.

- [#453](https://github.com/lucasthevenet/arcadekit/pull/453) [`8fa781d`](https://github.com/lucasthevenet/arcadekit/commit/8fa781d651de3a4d88b61c4d0ac05e4c2c485216) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Every method of an app returns an Effect, and a program yields it. `yield* app.tick(delta)` runs a tick and fails with what the game's systems fail with, and so do `app.frame` and `app.input`. `app.dispatch` fails with the action's refusal, `app.dispatchByName` with what the game's actions are refused with, `Action.UnknownAction` or `Action.InvalidPayload`, and `app.save` with `Save.SaveRefused`. What a driver steps answers the same way: `Driver.Tickable`, `Driver.Paced`, a session, `Transport.Connected` and `Session.syncTest`. What a session's tick threw, `Drift.Unlike`, `Drift.Drifted`, `Transport.Left` and `Session.RewindDiverged`, is now a failure that `Driver.run` fails with, so a program catches it by its tag. A call made where it may not be, such as `app.tick` from inside a tick, dies with the message it threw. `app.time`, `app.phase`, `app.settled`, `app.actionLog` and the lists of names stay values, and a view bridge's `send`, `get` and `subscribe` stay plain calls for a UI.

  Yielding a method costs its caller about 0.3 µs that a plain call did not. On a shared 4-core VM, `app.input()` of a game with `Input.plugin` and nothing changed measured 1.79 µs before and 2.17 µs now, of which the input stage's own work is 1.87 µs, each the fastest of 25 runs.

  What breaks, for every caller of these:

  - `app.tick(delta)`, `app.frame(alpha, delta)` and `app.input()` are `yield* app.tick(delta)`, `yield* app.frame(alpha, delta)` and `yield* app.input()`. `app.tickExit`, `app.frameExit` and `app.inputExit` are gone: `yield* Effect.exit(app.tick(delta))` gives the outcome as a value.
  - `app.dispatch(Move, payload)` and `app.dispatchByName(name, json)` returned an `Exit`. They return an Effect: `yield* app.dispatch(Move, payload)` succeeds with what the handler returns, and `yield* Effect.exit(app.dispatch(Move, payload))` is the `Exit` it returned.
  - `app.enqueue(Move, payload)` is `yield* app.enqueue(Move, payload)`, which fails with `Action.InvalidPayload` as its `Exit` did, and `app.enqueueByName(name, json)` is `yield* app.enqueueByName(name, json)`.
  - `app.save()` is `yield* app.save()`, which fails with `Save.SaveRefused`. `app.record(since)`, `app.checkpoint()` and `app.inspect()` are `yield* app.record(since)`, `yield* app.checkpoint()` and `yield* app.inspect()`.
  - `Timeline.capture(app)` returned an `Exit`: it is `yield* Timeline.capture(app)`, which fails with `Save.SaveRefused`. `Timeline.rewind(app, moment)` is `yield* Timeline.rewind(app, moment)`.
  - `Driver.fixedStep(app, { hz })` returns a step to yield: `yield* step(seconds)` succeeds with the ticks it ran. A hand-made `Driver.Tickable` or `Driver.Paced` returns an Effect from `tick`, `input` and `frame`.
  - `session.tick()`, a connected session's `tick()` and a sync test's `tick(delta)` are `yield* session.tick()` and so on. `session.tickExit()` and a sync test's `tickExit(delta)` are gone. A sync test's `tick` fails with `Session.RewindDiverged` where it threw, and a connected session's with `Transport.Left`.
  - `Driver.run`, `Driver.frames` and `Driver.interval` fail with what a tick or a frame fails with, where they died with what it threw. `Journal.replay` fails with what a tick of the replay fails with.

- [#509](https://github.com/lucasthevenet/arcadekit/pull/509) [`9d973f4`](https://github.com/lucasthevenet/arcadekit/commit/9d973f4c4d30e3dfd681d4a924defad1c784c62d) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `App.Any` takes what an app's systems fail with, `App.Any<E>`, so code that runs any app's `tick`, `frame` or `input` names that failure instead of `unknown`: `App.Any<never>` takes only a game whose systems can't fail, and a function generic in `E` takes any app and passes on what its systems fail with. An `App.App<E, HU>` is an `App.Any<E>`.

  Nothing breaks: bare `App.Any` is the type it was, and its `tick`, `frame` and `input` still fail with `unknown`.

- [#305](https://github.com/lucasthevenet/arcadekit/pull/305) [`d3d55b3`](https://github.com/lucasthevenet/arcadekit/commit/d3d55b30877d7dfc7a81284598a096f4137aaf93) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - An app has a scope of its own, and `app.close` closes it. `App.make` requires no `Scope`: it builds the plugins' layers, listens to the devices and opens the sound in its own scope, which lasts until the app is closed, and is closed at once when the making fails. An app made in a scope that has since closed, as `Effect.runSync(Effect.scoped(App.make(game)))` makes one, still hears the page's devices and plays its sound; before, its devices threw and its sound played nothing, with no error. `Driver.run` closes the app it runs when it ends, is interrupted, or a tick throws. `Transport.connect` listens in a scope of its own too: the connection has `close`, which stops listening and closes the session it connected. After `close`, a page's devices, its sound and a transport of the package each throw when used, and say that what opened them was closed; a page's sound used to play nothing.

  What breaks:

  - `App.make`, `Session.make`, `Session.syncTest`, `Journal.replay` and `Transport.connect` require no `Scope`, and closing the scope a program ran them in no longer lets go of what they opened. A program that makes an app itself and runs it with `Driver.frames` closes it when done, as with `Effect.acquireRelease(App.make(game), (app) => app.close)`. `Driver.run` needs nothing: it closes what it made.
  - `Driver.run` takes an effect that makes something with `close`: an app, a session, or a connection made by `Transport.connect`. A step of that effect that can fail after the app is made holds the app with `Effect.acquireRelease`, so that it is closed when the step fails.
  - `Transport.connect(session)` takes the session's `close`, and its connection's `close` closes the session.
  - A session's app, `App.Steered`, has no `close`: `session.close` and `test.close` of `Session.syncTest` close it.
  - The app a `Journal.ReplayDiverged` holds has been closed by the replay: read it, and do not close it.
  - A frame or input system that requires a `Scope` is given the app's, and `App.make` no longer requires one for it.
  - `Browser.layerSound`'s speaker, and so `Sound.open` under `Browser.layer`, throws when played after it was let go, where it played nothing. The messages of the devices and of `Transport.layerBroadcastChannel` and `Transport.layerWebSocket` used after they were let go say so in other words.

- [#246](https://github.com/lucasthevenet/arcadekit/pull/246) [`b4ee0d4`](https://github.com/lucasthevenet/arcadekit/commit/b4ee0d4b45e47187ab83a2f2fbcd30a3b8564056) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `app.phase` says what an app is running: `"idle"` between ticks, `"tick"`, `"frame"`, `"input"`, or `"handler"` for an action's handler that `dispatch` runs. A handler a tick runs is part of the tick. The app's own between-ticks checks read it, and they now refuse what a handler `dispatch` runs did unchecked: a tick, a frame, the input stage, a save, a capture, a recording, a checkpoint or an inspection taken halfway through an action, which the action could still take back.

  **Breaking**

  - `app.tick()`, `app.frame()`, `app.input()`, `app.save()`, `app.capture()`, `app.record()`, `app.checkpoint()` and `app.inspect()` throw when called from a handler that `dispatch` runs. Call them after `dispatch` returns.
  - `app.checkpoint()` also throws during the frame and input stages, as the others do.
  - `app.rewind()` from a handler says `was called during a handler of "…"`, where it said `was called from the handler of "…"`.

- [#526](https://github.com/lucasthevenet/arcadekit/pull/526) [`953717f`](https://github.com/lucasthevenet/arcadekit/commit/953717f8a3e73a846296b7cfc7e338c4fc993d05) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - An entity counts its own teleports, and everything that draws it between two ticks draws it where it landed. `Transform2d.Teleports` and `Transform3d.Teleports` hold a `count`, which the tick that teleports an entity adds one to. Every reader of `Transform2d.smooth` and `Transform3d.smooth`, and every kind of `@arcadekit/three` drawn with `smooth: true`, then draws the entity at its position, rotation and scale until the next tick, with no `snap` given, so two readers can no longer draw one teleport two ways. The count is a component of the game: a rewind takes a teleport back, and a peer that hears of one late draws the entity where it landed. An entity without it costs nothing.

  **Breaking**: `Transform2d.smooth` and `Transform3d.smooth` require `World` beside `Frame` and `Time`. A frame system has all three, so a game that yields them there changes nothing; one that provides them by hand provides `World` too. `snap` stays, for a long move the game doesn't count as a teleport.

- [#353](https://github.com/lucasthevenet/arcadekit/pull/353) [`1de8ca9`](https://github.com/lucasthevenet/arcadekit/commit/1de8ca907ab8ccf133891788e7a225c3d78fd614) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - An `Entity`, an `Entity.Ref` and a `Spawned` id are no longer numbers to the compiler. A `Uint32Array`, a number field such as `Field.u32`, and arithmetic or a bitwise operator kept only an id's low 32 bits, and lost the generation of a slot reused more than 1,023 times with no error. None of them takes an id now. An id is still a number when the game runs, so JSON, saves, snapshots and the hash are unchanged. An `Entity` is still an `Entity.Ref`, and an `Entity.Ref` still not an `Entity`.

  **Breaking**:

  - An id compares with `===` and keys a `Map` or a `Set`. Code that added to an id, sorted ids with `a - b`, or took its bits with `&` or `>>>` reads its parts with `entityIndex` and `entityGeneration` instead:

    ```ts sketch
    // before
    ids.sort((a, b) => a - b);
    const slot = entity & 0x3f_ff_ff;
    // now
    ids.sort((a, b) => entityIndex(a) - entityIndex(b));
    const slot = entityIndex(entity);
    ```

  - The `entities` column that `eachChunk` hands out is an `EntityColumn`, a `ReadonlyColumn<Entity>`, and no longer a `Float64Array`. A `Field.entity` of a term the query writes is a `WritableColumn<Entity.Ref>`. Both are indexed as before, and neither has the methods of a typed array.
  - `SparseColumns.indexOf` takes an `Entity`.
  - An id written into a template string reads as a number at run time, as before, but a type-aware lint that refuses an object there now refuses an id. Write its parts instead.
  - `@arcadekit/three` names the entity of a colour that is no colour by its slot and generation.

- [#254](https://github.com/lucasthevenet/arcadekit/pull/254) [`d9a7584`](https://github.com/lucasthevenet/arcadekit/commit/d9a758455b86c8ce33cc876f40293f2a8b1cd8cc) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - How an action enters a game is a module of its own, `arcadekit/Inbox`: queueing it for the next tick, applying it now, the transaction around its handler, and handing it to a session that has taken the app over. `App.make` uses it as before, and an app's `enqueue`, `dispatch`, `enqueueByName` and `dispatchByName` are unchanged. A `Runner` now also says what the app is running: `phase`, `simulating`, `whileIdle`. Nothing breaks.

- [#318](https://github.com/lucasthevenet/arcadekit/pull/318) [`33419e3`](https://github.com/lucasthevenet/arcadekit/commit/33419e391d31d102f09f7fb5e3c79d15200b1cff) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Save.decode` refuses a save in a format an earlier version of arcadekit wrote with the problem `"older format"`, where it said `"newer format"`.

  **Breaking**

  - `Save.LoadRefused`'s `problem` has a new member, `"older format"`. A game that matched on `"newer format"` to tell the player a save can't be read matches on both.

- [#275](https://github.com/lucasthevenet/arcadekit/pull/275) [`63a5fd1`](https://github.com/lucasthevenet/arcadekit/commit/63a5fd1d74f2142212f179807c5e49984c56275e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A list of systems in which one would react a tick late to another doesn't compile. A system that watches a component with `Query.changed`, listed ahead of a system that writes it in the same tick, saw the write on the next tick, with no error. Now `App.define` and `Plugin.make` refuse that list, and the error names the two systems and says which to list after the other.

  Nothing is declared. Yielding a query puts what it writes and watches in the requirements, as `Query.Writes<"game/Position">` and `Query.Watches<"game/Position">`, so a system's type says it, through a branch, a condition or another Effect alike. The app provides them, since they stand for nothing at run time. The check follows the order a tick runs: stage by stage, a plugin's dependencies before the plugin, plugins before the app's own. Hooks, handlers, and the frame and input stages run at another moment and are left out.

  **Breaking**:

  - A list with a watcher ahead of its writer no longer compiles. List the watcher after the writer, or place it in a later stage.
  - `System.System` has three more type parameters, for the system's name, its stage and what triggers it: `System<E, R, N, St, Tr>`. `System.System<E, R>` is still any system of that error and those requirements. A function's `ReturnType` that was used as the type of any system now names one system: write `System.System<E, R>`.
  - `Query.Query` has a second type parameter, the names of the components it watches, and yielding a query requires `Query.Needs<D, W>` where it required `World`. `Plugin.Plugin` has a seventh, its systems in order.
  - A query that writes or watches can't be yielded outside an app by providing `World` alone. Code outside the simulation reads it from the world:

  ```ts
  // Before
  const moved = yield * Moved.pipe(Effect.provideService(World, app.world));

  // Now
  const moved = app.world.view(Moved);
  ```

  `@arcadekit/three` draws as before: the types of its queries say that they only read.

- [#341](https://github.com/lucasthevenet/arcadekit/pull/341) [`2183526`](https://github.com/lucasthevenet/arcadekit/commit/218352600aadb7eefc1f058c40bc0c77e20d45c5) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `CommandBuffer.apply` throws while a query is iterating, inside a transaction, and in a frozen world, before it makes any command, and keeps the whole queue for a later `apply`. It used to make a queued spawn there with no error, which a rollback did not undo, and to throw at the first despawn, add or remove after emptying the queue, which lost that command and every one after it.

  **Breaking**: a call to `apply` in one of those places throws now, even when the queue holds only spawns or is empty. Call it after the loop, after `commit` or `rollback`, or after `thaw`.

- [#539](https://github.com/lucasthevenet/arcadekit/pull/539) [`e409161`](https://github.com/lucasthevenet/arcadekit/commit/e409161e17bec24dd3fe6b33321186376b81404e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A definition is plain data, and a system asks for what it needs with a capability: a function named for the access it gives, applied to the definition. `yield* Query.View(Moving)` gives a query's view, and `yield* Event.Emitter(Collided)` the handle that emits. There is one way to ask where there were three: a bare `yield*`, a getter such as `.emits`, and a function such as `World.writes`.

  A capability costs a call, not a turn of the fiber's loop: about 25 ns where a yielded definition took about 210 ns. A tick of ten systems that do no work is about a fifth faster.

  **Breaking**

  A query, an event, a singleton, a state, a control, a bundle, a slot, a local and a setting are no longer Effects. Wrap each in its capability, where it is yielded and where it is passed as an Effect, as in `app.read(Singleton.Read(Score))`:

  | Before                         | After                            |
  | ------------------------------ | -------------------------------- |
  | `yield* Moving`                | `yield* Query.View(Moving)`      |
  | `yield* Query.removed(Sprite)` | `yield* Query.Removed(Sprite)`   |
  | `yield* Collided`              | `yield* Event.Reader(Collided)`  |
  | `yield* Collided.emits`        | `yield* Event.Emitter(Collided)` |
  | `yield* Score`                 | `yield* Singleton.Read(Score)`   |
  | `yield* Score.writes`          | `yield* Singleton.Write(Score)`  |
  | `yield* Mode`                  | `yield* State.Reader(Mode)`      |
  | `yield* Mode.sets`             | `yield* State.Setter(Mode)`      |
  | `yield* Jump`                  | `yield* Input.Read(Jump)`        |
  | `yield* Forest`                | `yield* Assets.Status(Forest)`   |
  | `yield* Auto`                  | `yield* Save.Status(Auto)`       |
  | `yield* Orbit`                 | `yield* System.Kept(Orbit)`      |
  | `yield* Volume`                | `yield* Setting.get(Volume)`     |
  - `asEffect()` is gone from each of them, and so is `pipe`, but for a query, which keeps `Query.all(...).pipe(Query.writes(Position))`. Pipe a setting with `pipe` from `"effect"`: `pipe(Keys, Setting.set(value))`.
  - The class `Query.Removed` is gone. `Query.Removed(component)` is the capability, and takes the component.
  - What a system requires is the same as before, so a stage refuses what it refused: a frame system that asks for `Event.Emitter`, `State.Setter`, `Singleton.Write` or the view of a query that writes doesn't compile.
  - A lookup that throws, such as `Event.Emitter` outside the tick, throws at the line that asked, where a `try` around it catches it.

- [#207](https://github.com/lucasthevenet/arcadekit/pull/207) [`b820835`](https://github.com/lucasthevenet/arcadekit/commit/b8208350fc401dc5d66b45cf54a22e01b1bf378a) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - In a page, `Browser.runMain` and `Browser.layer` read an asset's path against the document's base, its `<base href>`, as `fetch` does, where Effect's `HttpClient` read it against the page's address. A loader of the game's own, provided around the layer, is kept.

  **Breaking**

  - A page with a `<base href>` loads its assets from where the base says. A game that set a base and relied on paths read from the page's address writes those paths from the base, or as absolute URLs.

- [#365](https://github.com/lucasthevenet/arcadekit/pull/365) [`96d3047`](https://github.com/lucasthevenet/arcadekit/commit/96d304764f9b9250a4aae713402dc24e6c1d29e8) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Assets.Store` fetches a file once for every held bundle that names it, decodes an asset once for every held bundle that has it, and releases it when the last of them is let go. A fetch that got no answer or was cut off, or a server's answer of 500 or more, is tried again up to three times, 200, 400 and 800 milliseconds later, so a bundle recovers without its level being entered again. `Assets.AssetFailed` has an optional `transient`, which the default loader sets for those failures, and which a loader of a game's own sets for a failure worth trying again.

  Nothing breaks: `Assets.Status`, `Assets.during`, `hold` and `drop` are as they were.

- [#497](https://github.com/lucasthevenet/arcadekit/pull/497) [`adbe2ed`](https://github.com/lucasthevenet/arcadekit/commit/adbe2ed4becca11a5dbfc6d476b573ce8382d7f6) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Transform3d.axisAngle` gives the same numbers in every JavaScript engine, so a tick may call it. Its sine and cosine are fdlibm's, the ones V8's `Math.sin` and `Math.cos` give, made of `+`, `-`, `*` and `/`, and it measures its axis with `Math.sqrt` in place of `Math.hypot`. ECMAScript lets each engine round `Math.sin`, `Math.cos` and `Math.hypot` its own way, so two peers on different engines could compute two rotations. Nothing breaks: a game calls it as before. A rotation it returns may differ from before in its last bit.

- [#358](https://github.com/lucasthevenet/arcadekit/pull/358) [`6e8b6ca`](https://github.com/lucasthevenet/arcadekit/commit/6e8b6ca820a7ae6cdb3ea30213aa0d5dfb8ea112) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - What only a page can use is laid out as Effect 4.1.4 lays out a folder of modules, as `arcadekit/net` is: `arcadekit/browser` gives its modules as namespaces, `import { Browser, Audio } from "arcadekit/browser"`, and each module is an entry of its own at its path, `arcadekit/browser/Browser` and `arcadekit/browser/Audio`. What they keep to themselves is in `src/browser/internal/`. Part of [#265](https://github.com/lucasthevenet/arcadekit/issues/265).

  What breaks:

  - The entry `arcadekit/Browser` is gone. Import `{ Browser }` from `arcadekit/browser`, or `* as Browser` from `arcadekit/browser/Browser`. `Browser` exports the same names as before, the page's sound among them, so `Browser.runMain`, `Browser.layer`, `Browser.image` and `Browser.layerSound` are written as they were.

- [#397](https://github.com/lucasthevenet/arcadekit/pull/397) [`e3c1733`](https://github.com/lucasthevenet/arcadekit/commit/e3c17338259952b7e689d6f39eaee4109f2bb6ca) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The packages are built by the TypeScript compiler, one file of `dist/` for each source file, and nothing is bundled. A module that an entry gathers is that module. `import { Transform3d } from "arcadekit"` is the module `arcadekit/Transform3d`, at run time and in its type, so it can be passed as `transform` to `Three.instances` and `Three.objects`. The same holds for each module of `arcadekit`, `arcadekit/net`, `arcadekit/browser` and `@arcadekit/three`.

  What breaks:

  - Each module no longer exports a copy of its own namespace, such as `Transform3d_exports` in JavaScript and `Transform3d_d_exports` in its declarations. A game that named one names the module instead.
  - The built files of `arcadekit/ecs`, `arcadekit/net` and `arcadekit/browser` are `dist/ecs/index.js`, `dist/net/index.js` and `dist/browser/index.js`. A game that imports the entries by name is not affected.

- [#370](https://github.com/lucasthevenet/arcadekit/pull/370) [`a7b5006`](https://github.com/lucasthevenet/arcadekit/commit/a7b5006d60f1bdb5dfe262116114d454bf704423) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Timeline.capture`, `Timeline.rewind` and `world.hash()` cost what changed since the last capture or hash, not the size of the world. A component's columns in a table count as changed when a loop of a query that names the component in `Query.writes` visits the table, whether or not it assigns a value, when `world.set` writes it, or when an entity joins or leaves the table. A moment copies only what changed and shares the rest with the moment before, and a rewind copies back only what changed, in place. Checkpoints, a replay's comparisons, `Session.syncTest` and `verifyFrames` still hash every column, so that a write through a cast past `Query.writes` shows up there.

  **Breaking**

  - `world.hash()` returns other numbers for the same world, since each column is now hashed on its own. A recording made by an earlier version fails its replay at its first checkpoint, with `Journal.ReplayDiverged`: record it again. Saves and snapshots are unchanged, and load as before.
  - A `Field.transient` field keeps its value through `Timeline.rewind` in a table that nothing changed since the moment. It used to be `undefined` after every rewind, and still is where a loop or `world.set` wrote its component, or an entity joined or left its table. A system that builds a cache when it finds the field `undefined` works as before, and builds it less often.

- [#207](https://github.com/lucasthevenet/arcadekit/pull/207) [`ad8256e`](https://github.com/lucasthevenet/arcadekit/commit/ad8256e85dba65688363ecddfaea5964a09571f8) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A component can say what it is when it is added or spawned bare, with `Component.define(name, fields, { initial })`, where it was always all zeros. `Transform2d.Scale` and `Transform3d.Scale` are 1 along each axis when added bare, where a bare one was all zeros and drawn as nothing.

  **Breaking**

  - A bare `Transform2d.Scale` or `Transform3d.Scale` is 1 along each axis. A game that added one bare and relied on its zeros gives it `Scale.of({ x: 0, y: 0 })`.
  - `ComponentDef` has an `initial` property, undefined unless the component gives one.

- [#476](https://github.com/lucasthevenet/arcadekit/pull/476) [`48fd05d`](https://github.com/lucasthevenet/arcadekit/commit/48fd05dcf019035ea018f7ebae8a66e13b20f2e4) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game names what its player does as a control, binds it to the devices, and reads it in its rules, which name no key. `Input.button(name, codes)` is held while any of its codes is down, and `yield*` gives `{ held, pressed, released }`. `Input.axis(name, { negative, positive, pad })` is a number from -1 to 1, from two sets of keys and a gamepad's axis. `Input.stick(name, { left, right, up, down, pad })` is `{ x, y }`, y up and of length 1 at most, so two keys held together make a diagonal of length 1, with a radial dead zone for the gamepad's stick, 0.2 by default. `Input.controls(name, controls)` declares them in a plugin, and a game that reads a control it doesn't declare doesn't compile: `App.make` requires `Input.Declared<"game/Jump">`. The input stage works out what each control says with the app's bindings and reports it in `Input.Report` beside the devices' codes, so a recording and a rollback session play the same presses with no devices and whatever the bindings. A tick reads a control as it is in that tick, a frame system what changed since the last frame, and an input system what this sample says.

  Bindings are settings, outside the world, the save and the hash, each app its own: a frame or input system changes them with `Input.rebind(control, bindings)` and reads them with `Input.bindingsOf(control)`, and a tick that rebinds doesn't compile. A settings menu, which runs outside every system, takes `Input.settingsOf(app, Controls)`, whose `rebind` and `bindingsOf` take only the controls `Controls` declares, and keeps them in a setting of the control's schema, `Setting.define("game/JumpKeys", Jump.schema, Jump.bindings)`, which the page applies when the game starts. A code is a type: `Input.KeyCode` lists the values of `KeyboardEvent.code`, and `Input.ButtonCode` and `Input.AxisCode` add the pointer's and the gamepads' templates, so `"Spce"` doesn't compile where a code goes. `Input.isKeyCode` checks a string, and `Input.padStick(pad, "left" | "right")` names a standard gamepad's sticks. In an input system, `Input.Keyboard`, `Input.Pointer` and `Input.Gamepad` read the stage's sample, so `Three.toPlane(yield* Input.Pointer)` turns a click into a place of the game.

  **Breaking**:

  - `Input.bind`, `Input.onPress`, `Input.onRelease`, `Input.onMove`, `Input.Binding` and `Input.PayloadOf` are gone. A game declares a control and reads it in its rules, or issues its own action from an input system: `if ((yield* Jump).pressed) (yield* Action.Actions).enqueue(Leap, {})`. The walkthrough's `Input.onRelease(["ArrowLeft", "ArrowRight"], Move, { dx: 0 })`, which stopped the basket while the other arrow was held, is an `Input.axis` its rules read.
  - A code is no longer a `string`: `Input.ManualSource`'s `press`, `release`, `tap` and `move`, `Input.Sample`, `Input.KeyboardView.down`, and `Browser.layer`'s `preventDefault` take the codes' types, and `pointerButton`, `padButton` and `padAxis` return them. `Input.Keyboard` reads keys only, not a pointer's or a gamepad's button. A page's listener hears no key whose code isn't an `Input.KeyCode`.
  - In an input system, `Input.Keyboard`, `Input.Pointer` and `Input.Gamepad` read the stage's sample of the devices, where they read the world's state as of the last tick.
  - `Input.plugin` no longer suggests `Input.bind` for several players: such a game issues actions that carry the player from an input system that reads `Input.Devices` or its controls.
  - In `@arcadekit/three`, `Camera.toPlane`'s example and the flat game's test read a click as a control and the pointer from `Input.Pointer`. Nothing of its API changes.

- [#465](https://github.com/lucasthevenet/arcadekit/pull/465) [`0009229`](https://github.com/lucasthevenet/arcadekit/commit/0009229e195dcfb668da9e61f021b05799162eef) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game names its sounds in a cue sheet, and a menu sets how loud each kind is. `Sound.sheet(name, { coin: "/coin.wav", theme: Audio.stream("/theme.ogg") })` makes a clip for each sound, so `Sound.on(Scored, Sfx.coin)` plays one and a cue the sheet doesn't have doesn't compile. Every sound plays on a bus, and `Sound.Player`'s new `volume(bus, volume)` sets a bus's volume from a frame system: 0.5 at half, 0 silent. A bus is a value of the class `Sound.Bus`, declared once, so a bus that was never declared doesn't compile: `Sound.EffectsBus` is a cue's unless its options name another with `bus`, `Sound.MusicBus` a track's, and `Sound.bus(name)` declares one of a game's own. A game that needs only those two declares nothing: `player.volume(Sound.MusicBus, 0.5)`. A recorder records a sheet's sound by its name, as it recorded a named cue, at the volume it was played at, its bus's included.

  **Breaking**

  - The record of `sounds` by string is gone. `Browser.runMain(game, { sounds: { coin: "/coin.wav" } })` is now `Browser.runMain(game, { sounds: [Sfx] })` with `const Sfx = Sound.sheet("game/Sfx", { coin: "/coin.wav" })`, and `Audio.layerSound({ coin: "/coin.wav" })` is now `Audio.layerSound([Sfx])`.
  - A cue or a track is a clip, never a name: `Sound.on(Scored, "coin")` is now `Sound.on(Scored, Sfx.coin)`, `player.play("click")` is `player.play(Sfx.click)`, and a music body returns `Tracks.theme` where it returned `"theme"`. `Sound.Playable` is `Sound.Clip`, and a `Sound.Speaker` of a game's own is given a clip.
  - A sound of a sheet the page wasn't given is logged once with the sheet's name and plays nothing, where a name with no file was logged before.
  - The page's example drops its `?stream` switch: its theme is a file of its sheet.

- [#267](https://github.com/lucasthevenet/arcadekit/pull/267) [`fcc0b4c`](https://github.com/lucasthevenet/arcadekit/commit/fcc0b4c8e88c97231df39a690543b2e365f92d51) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A page's devices are listened to in the scope of the program that makes the app, not where `Browser.layer` is provided. `Input.Source` holds `listen`, an effect that starts listening to the devices in the current scope, stops when that scope closes, and gives an `Input.Listener`; `App.make` runs it. `Browser.layer` provided to `App.make` alone stopped listening once the app was made, and the first read threw; now the devices are heard for as long as the program that made the app, wherever the layer is provided. Each app listens for itself, so two apps made under one `Browser.layer` each hear every press, where before they shared one set of listeners and the first to read took the presses from the other. `Input.listen` listens to the devices for a program that samples them itself, and `Input.layer(listener)` provides devices made by hand, such as `Input.makeManualSource()`.

  The page's sound in `Browser.layer` is still made when the layer is built, so provide the layer to the whole program, as `Browser.runMain` does, for its sound to last.

  What breaks:

  - `Effect.provideService(Input.Source, source)` is `Effect.provide(Input.layer(source))`.
  - `yield* Input.Source` gives `{ listen }`, not the devices: `yield* Input.listen` gives them, in the current scope.
  - `Input.SourceShape`, the devices being listened to, `{ sample }`, is `Input.Listener`. `Input.Source` is the interface of what the service holds.
  - `Browser.layer` listens to nothing when it is built: `Layer.build(Browser.layer())` no longer listens to the page.

- [#460](https://github.com/lucasthevenet/arcadekit/pull/460) [`d124b09`](https://github.com/lucasthevenet/arcadekit/commit/d124b097a0d0f04ffc478d1fecc10281be64e76a) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A frame system of the game's own draws an entity between its last two ticks with `Transform2d.smooth` or `Transform3d.smooth`, where it had to keep a previous position in the world. `const smooth = yield* Transform2d.smooth` hands out `smooth.position(entity, position, snap)`, `smooth.rotation(entity, rotation)` and `smooth.scale(entity, scale)`, each `Frame.alpha` of the way from where the entity was a tick ago. An entity that moved farther than `snap` in a tick, such as one that was teleported, is drawn where it is. `smooth.positions`, `smooth.rotations` and `smooth.scales` blend a run of rows that `eachChunk` hands out, with no allocation per entity, and `Color.smooth` blends a `Color.Rgb` the same way. Only a frame system can yield one, since each requires `Frame`. The app records an entity's values when a frame first reads it, outside the world, so a game that draws nothing smoothly keeps nothing, and the hash, log and save are the same with it or without.

  `Three.instances` and `Three.objects` with `smooth: true` read the same store, so a camera that follows an entity with `Transform3d.smooth` stays on the instance or the object that draws it.

  Nothing breaks. One thing a game sees differently: an entity is drawn from where it was whenever any system drew it smoothly in the previous frame, where it was drawn where it is after a frame in which its own system didn't run.

- [#150](https://github.com/lucasthevenet/arcadekit/pull/150) [`c418a02`](https://github.com/lucasthevenet/arcadekit/commit/c418a024fca9f61a6508b5667db08c21a501e5b7) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The first cut of the revamped arcadekit: an entity component system with Effect 4 around it, for games of any genre.

  - A storage core with archetype tables, typed-array columns, opt-in sparse components, cached queries and a command buffer. A world keeps the names of the components it stores, and nothing is shared between worlds. A number left out of a component's value, which JavaScript and a cast allow, is 0 in the world as in a component added with no value, and never NaN; `world.set` leaves a number it names and is given no value for as it was.
  - No code is made from text. What `each` hands its callback is an object with a getter and a setter per field, made of closures, where it was a class generated with `new Function`. A page under a Content Security Policy with no `'unsafe-eval'` now runs a game as it is; before, it stopped at the first `Component.define`. `each` costs about 1 ns an entity more than it did with two components in the program, and four tenths less with ten.
  - A system can say what it reads and writes: `System.access({ queries, reads, writes, random, actions, scripts })`. It is all of what the system does, and the app holds a system that said it to it: a query, a singleton, an event, a command, an action or a script that was left out throws where it is made and says what to add, and a draw from `Random` is found when the system has run. `app.conflicts` then lists the pairs of systems that touch the same component, singleton, state or event, one of them to write it, in an order that nothing but the order they were listed in decides, and `app.undeclared` the systems that have not said; `System.conflicts` and `System.accessOf` are the same for any list of systems. With the storage core on its own, `world.guard`.
  - An entity's id is 22 bits of index and 31 of generation: a whole number below 2^53, kept in arrays of 64-bit floats. It was 32 bits with ten of generation, and an id kept across 1,024 reuses of its slot named a newer entity. A slot whose generations are used up is given out no more, so an id never names another entity than its own. A snapshot is written in format 3 and read from formats 1 to 3; `EntityId` takes any whole number below 2^53.
  - Change queries: `Query.changed` and `Query.added` visit only the entities that had a component written, or gained one, since the system last looked, and `Query.removed` gives the ones that lost one. Every system sees every change once, a visit costs next to nothing when nothing changed, and what a query has yet to visit is saved with a game.
  - Singletons: `Singleton.define` declares data the world holds one of, such as whose turn it is, and `yield*` gives its value to read and write. It is saved with the world and counted in its hash, and a refused action's writes to it are taken back.
  - Relations: `Component.relation` declares a component that points at another entity and says what that entity's despawn does to whoever points at it: despawned with it, like a parent's children, or left without the relation. Nothing is left pointing at an entity that is gone, and `world.sources` gives who points at one.
  - States and run conditions: `State.define` declares the few named values a game can be in, `System.runIf(State.is(...))` runs a system only in some of them, and `State.onEnter` and `State.onExit` make a system a hook that runs once on the way in or out. A state is a singleton, so it is saved and replayed.
  - A frame stage: a system made with `System.inStage("frame")` runs when `app.frame(alpha, delta)` is called, between ticks, to draw the game. `Frame` tells it how far the frame is between two ticks. The world is frozen there, so it cannot change the game, and a game that is drawn has the same hash, log and save as one that is not. A draw from the world's random generator there is found when the frame ends, and taken back. `Driver.fixedStep` runs the ticks that are due and then the frame stage.
  - A frame has three stages, as a tick has: `"preFrame"`, `"frame"` and `"postFrame"`, each run whole before the next. `Assets.during` is in the first, so every system of a frame finds the same assets loaded wherever it is listed; a renderer's last step belongs in the third. `System.before` and `System.after` said of a system in another stage are accepted when they are true already and throw when they cannot be.
  - A frame loop: `Driver.frames(app, { hz })` follows the display, running the ticks that are due and then the frame stage each time a frame is due. It pauses while the tab is hidden, and interrupting it leaves nothing running. It reaches the screen through `Driver.Display`, whose default is a timer, which a page replaces with `requestAnimationFrame` (`Browser.display`) and a test with `Driver.makeManualDisplay()`.
  - Input: an input stage, `System.inStage("input")`, runs just before each tick with the world frozen, is told what the keyboard, the pointer and the gamepads say as `Input.Devices`, and issues actions that are logged, so a replay reads no device. `Input.plugin` keeps a picture of the devices in the world, read with `Input.Keyboard`, `Input.Pointer` and `Input.Gamepad`; `Input.bind` with `Input.onPress`, `onRelease` and `onMove` turns the devices into the game's own actions. `Browser.layer()`, from `arcadekit/Browser`, is a page's devices and `Input.makeManualSource()` a source worked by hand.
  - Assets: `Assets.bundle` names assets that are loaded and let go together (`Assets.json` with a schema, `text`, `bytes`, `Browser.image` in a page, or `Assets.make` for a kind of your own). `Assets.load` loads one into the scope it is run in. `Assets.plugin` gives an app a store, and `Assets.during(condition, bundle)` keeps a bundle loaded while a condition holds, a state as a rule, and frees it when the game leaves: `yield*` on the bundle, in the frame stage or the input stage, says whether it is `Loading`, `Ready` or `Failed`. Loading is no part of the simulation, and a replay loads nothing. Bytes come through `Assets.Loader`, which is `fetch` unless a test provides `Assets.layerMemory`.
  - Where a thing is: `Transform3d.Position`, `Transform3d.Rotation` and `Transform3d.Scale`, three components of 32-bit floats that a game's rules write and a renderer reads, listed by `Transform3d.plugin`, with `Transform3d.axisAngle` to make a rotation, about an axis of any length. A `Rotation` is its turn and not its length: a quaternion of any length stands for the turn of the one of length 1 along it, and all zeros for no turn. A flat game has `Transform2d`, the same three with no third dimension and an `angle` for a turn. `@arcadekit/three` draws from either.
  - A view bridge: `View.define` declares a value the UI may see, `View.publish` makes the frame system that works it out and publishes it only when it changed, and a UI built with anything holds a `View.Bridge` (`View.makeBridge()`, provided with `View.layer`): it reads views with `get` and `subscribe`, and acts with `send`, which the input stage issues as a logged action before the next tick. `View.plugin` connects an app to it, and tells the bridge which actions the game handles: `send` of another throws where it is sent, and no longer a frame later in the game's loop. `Actions.handles(action)` says the same to a system. Where there is no UI nothing is worked out, and the game is the same game.
  - `Ticks.more()`: a system, a handler or a script says that the game has more to do next tick, which keeps a game that ticks when needed from resting in the middle of a clock's run. An app that has just been made or loaded runs a tick before it rests.
  - A tick hears the devices first: `app.tick(delta)` runs the input stage itself when nothing has since the tick before, so a game stepped by hand hears its keys and its UI with no `app.input()`. `app.tick(delta, { input: false })` is a tick that reads nothing, which is how `App.replay` ticks.
  - `System.otherwise(effect)` gives a system something to do in place of running, each time its `System.runIf` condition does not hold, so that what it keeps outside itself is not left as it last was. `Sound.music` uses it: a music system that does not run is silent. `View.reset(view)` is what a gated view gives it, to be put back to its first value.
  - Music: `Sound.music(name, body)` makes a system of the frame stage whose body says each frame what its channel should be playing, a track's name or one with a `volume` and a `fade`, or nothing. The player tells the output only of a change, and the output plays the track over and over, or with `once: true` to its end, and fades from one to the next. It is worked out from the game and kept nowhere, so a game loaded from a save has its music. A level's sounds are assets: `Browser.sound(url)` gives a `Sound.Clip`, which goes wherever a cue's or a track's name goes, and `Sound.cues(name, bundle, (assets) => lines)` makes a level's cues of what its bundle holds. A long piece of music is `Browser.stream(url)`, a clip that is fetched as it plays where every other sound is decoded whole. A page's audio sleeps while the page is hidden. Systems made with it are one score, on the channel `"music"`: of a menu's and a level's the one with something to play is heard, a track both play goes on, and two that say different tracks in one frame fail it with an error. What plays beside the score names a `channel` of its own.
  - Sound: `Sound.cues(name, Sound.on(event, cue), ...)` makes a system of the frame stage that plays what the simulation's events sound like, each event heard once and a cue played once per frame however many events, and however many systems, ask for it. `Sound.Player`, from `Sound.plugin`, plays a named cue and throws in the tick: the simulation never plays, and a replay is silent. Where it goes is `Sound.Output`, nowhere by default; `Sound.makeRecorder()` is one for a test, and in a page `Browser.layerSound(files)`, or the `sounds` of `Browser.runMain` and `Browser.layer`, plays each cue's file with Web Audio from the first touch on. In a page, the first cue asked for before the page was touched, which a browser does not let it play, is said once through Effect's logger.
  - An entry point: `App.run(options, { hz })` makes the app and runs it on the frame loop until it is interrupted, in a scope of its own, so that the platform's `runMain` around it is all a game's entry needs: in a page, `Browser.runMain(App.run({ plugins: [Game] }, { hz: 60 }), { target: canvas })`. `ready` is handed the app before its first frame, and `save` goes on from a saved game.
  - A game that moves when its player does: `ticks: "whenNeeded"`, an option of `App.run`, `Driver.frames` and `Driver.fixedStep`, draws every frame and ticks only while something is waiting, then rests with the game's time standing still. `app.settled` says whether anything is: an action, a state to enter, a script waiting for a tick, an event not every system has heard.
  - An entry for every module: `arcadekit/App`, `arcadekit/Input`, `arcadekit/System` and the rest, each the module, imported whole, with `arcadekit` giving them all together. Each imports Effect alone. `arcadekit/Browser` is what only a page can use: `Browser.runMain`, which starts a game in a page with its display and devices provided, `Browser.layer`, `Browser.display` and `Browser.image`; it is the one entry that imports `@effect/platform-browser`, an optional peer. `arcadekit/ecs` is the storage core on its own, with no Effect.
  - `Query.reads` says which of a query's terms its loops only read. The compiler then refuses a write to them, a raw loop does not count them as written for the queries that watch them, and a handler's transaction does not copy them. A component's name is part of its type, which is how two components with the same fields are told apart.
  - Systems as generators, one Effect per tick, on a scheduler the game loop owns, so a tick is deterministic. Scripts are long-running fibers that advance only during ticks; one that fails is logged with its cause, and an app can be told to stop on one.
  - Typed events that every system sees exactly once. `Event.define` takes a schema, and `Event.encode` and `Event.decode` write an event as JSON and read it back.
  - Actions: a handler checks a move against the rules and applies it or refuses it with a typed error. A handler runs in a transaction of the world (`world.begin`, `commit`, `rollback`), so a refusal at any point leaves nothing behind: its writes, random draws, queued commands, events and enqueued actions are taken back, and the events it read are unread. Payloads are validated against a schema. What comes from outside the simulation is logged as JSON-safe data, in the order it arrives, and the log replays the game; what a system, a script or a handler issues with `Actions` is not logged, because a replay's own simulation issues it again. The log carries a checkpoint of the world's hash every so many ticks (`checkpointEvery`, and `app.checkpoint()`), and a replay stops with `App.ReplayDiverged` at the first that does not match.
  - Plugins that bundle a feature's systems, handlers, services and setup, and name the plugins they depend on.
  - Seeded randomness: `Random` gives `next`, `int`, `pick` and `shuffle` from a generator whose state is part of the world. `App.make({ seed })` seeds it, the same seed gives the same numbers on every machine, and Effect's own `Random` is seeded from it inside an app.
  - Saving and loading: `app.save()` gives the world, the time, the waiting actions and the waiting events; `Save.encode` and `Save.decode` turn a save into bytes and back; `App.load` brings the game back where it was. A plugin lists its `components` and its `scripts`, which start again after a load.
  - Versions and migrations: a save records the game's `version`; `App.load` brings an older save up to date with the game's `migrations`, which edit a self-describing form of the save with `Migrate`, and refuses a newer or unmigratable one with the reason.
  - Fields that are not numbers say what saving does with them: `Field.json` (plain data), `Field.schema` (any value an Effect schema describes), `Field.ref` with a codec of your own, and `Field.transient` (not saved, not hashed). The hash covers exactly what a snapshot saves.
  - `world.snapshot()` and `world.load()`: the whole world as compact bytes, and back into an empty world that hashes the same and goes on the same. A problem is a `SnapshotError` that says which kind and names the component.
  - `world.hash()`: one number for everything in a world that a simulation can tell apart, the same on every machine, which changes whenever one field of one entity does.
  - Built-in services keyed under `"arcadekit/"`: `World`, `Time`, `Frame`, `Commands`, `Script`, `Ticks`, `Events`, `Random`, `Action.Actions` and `Input.Devices`.
  - Lockstep: `Lockstep.make(app, { peer, peers, delta, delay })`, from the new entry `arcadekit/Lockstep`, makes an app one peer of a game of several. The session takes the app over with `app.divert`: what comes in from outside (`app.enqueue`, a key bound to an action, a button of the UI) goes into this peer's message for the tick `delay` ahead, and every peer applies it on that tick, in the order of the peers' names. A tick runs once the peer holds every peer's message for it. The session is given the messages that arrived (`receive`) and gives the ones to send (`outgoing`), as values or as text (`Lockstep.encode`, `Lockstep.decode`), and a driver steps it in the app's place. On an app that was taken over, `tick`, `dispatch` and `dispatchByName` throw.
  - Drift detection: the peers of a session send each other the checkpoints their logs record, and compare the state they start from before anyone's first tick. When every peer has said its hash for a tick and they are not all the same, the session stops: its tick fails with `Lockstep.Drifted`, which names the tick, every peer's hash and the last tick they agreed at, and `session.drifted` holds it. A system that is not deterministic is caught within `checkpointEvery - 1 + delay` ticks.
  - Rollback: `Rollback.make(app, { peer, peers, delta, delay, ahead })`, from the new entry `arcadekit/Rollback`, is the session that does not wait for the network. It runs up to `ahead` ticks past what every peer has said, as if the ones it has not heard from had nothing to say, and when a message comes for a tick that has run it goes back and runs forward again. A player's own move is in the next tick, and the peers end the same game. `session.confirmed`, `rewinds`, `resimulated` and `kept` say how it is going. Lockstep is this session with nothing run ahead.
  - `app.capture()` and `app.rewind(moment)`: the game as it stands, kept in memory, and the same app put back to it: the world, the time, the waiting actions and events and what change queries had yet to visit, with the log cut back. What is waiting needs no schema. Scripts are started again as after a load.
  - `world.restore(bytes)` puts a snapshot back into a world that is in use, in place of everything it holds. A view asked for before it throws when it is used, and says to ask again.
  - A transport: `Transport`, from the new entry `arcadekit/Transport`, is the service that carries a session's messages, `send` and `receive`. `Transport.connect(session)` joins a session to it and gives what a driver steps. `Transport.layerBroadcastChannel(name)` carries between the tabs, windows and workers of one browser; `Transport.text(wire)` makes a transport of anything that carries text; and `Transport.makeHub({ delay, seed })` is a network in memory for tests, which delays and reorders as it is told.
  - A handler is told who issued its action: `Action.handler(Pass, function* (payload, { from }) { ... })`. In a session `from` is the name of the peer that issued it, stamped from the message it came in, on every peer alike; `app.enqueueByName` and `app.dispatchByName` take it as a third argument, for a server that brings actions in for its clients; and it is undefined for an action the program issued itself. It is in the log, in a save with an action that waits, and in `Action.Rejected`.
  - A relay, and the transport to it: `arcadekit/Relay` is the relay between machines as a handler of plain functions, for whatever accepts the sockets to call. `Relay.join(url, present)` says whether a peer may come into the room its address names, `Relay.forward(member, data, present)` what to pass on to the other members, and `Relay.make()` keeps who is connected for a host that stays in memory. It refuses a message in another's name, so the `from` a handler is told is the peer the relay let in. `Transport.layerWebSocket(url)` is a peer's end: a WebSocket to the relay, which throws `Transport.Closed` with the relay's reason once it has closed.

  **Breaking**

  Everything. Nothing of the previous version remains: every earlier export is gone, and the package now has an entry for every module, `arcadekit` for all of them, `arcadekit/Browser` for what only a page can use, and `arcadekit/ecs`. A game is written against the new API described in the package's README. The Three.js plugin is a package of its own, `@arcadekit/three`, and `three` and `@types/three` are no longer peer dependencies of `arcadekit`. `foldkit` is no longer a peer dependency: the package does not depend on a UI library.

- [#493](https://github.com/lucasthevenet/arcadekit/pull/493) [`9d034ce`](https://github.com/lucasthevenet/arcadekit/commit/9d034cef24fb50a575a40a153c2aed30b0a93eb0) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Migrate.migrate`, `Replay.encode`, `Message.encode` and `Message.encodeAside` return an Effect, as every method of an app does, which fails with the error their `Exit` carried: `Save.LoadRefused`, `Replay.Invalid` and `Message.Invalid`. Each does its work when the Effect runs, not when it is called. A transport writes what it sends with them.

  **Breaking**

  - `Migrate.migrate(save, version, migrations)` returned an `Exit`: it is `yield* Migrate.migrate(save, version, migrations)`, and `yield* Effect.exit(Migrate.migrate(save, version, migrations))` is the `Exit` it returned. `Exit.isSuccess(Migrate.migrate(...))` no longer compiles.
  - `Replay.encode(recording)` is `yield* Replay.encode(recording)`.
  - `Message.encode(message)` and `Message.encodeAside(aside)` are `yield* Message.encode(message)` and `yield* Message.encodeAside(aside)`.

  `Replay.decode`, `Save.decode`, `Message.decode`, `Message.decodeAside`, `Message.decodeNotice`, `Event.encode`, `Event.decode`, `Relay.join` and `Relay.forward` still return an `Exit`.

- [#356](https://github.com/lucasthevenet/arcadekit/pull/356) [`3bf4fa5`](https://github.com/lucasthevenet/arcadekit/commit/3bf4fa56c762aaa4a365c73652c41c9611fdbe44) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The parts an app is made of, and the outbox an event is told through, are files behind the module each belongs to: `App` and `Event`. They were entries of their own because they came out of a long file, and no game imports them.

  What breaks:

  - The entries `arcadekit/Build`, `arcadekit/Inbox`, `arcadekit/Loop`, `arcadekit/Runner`, `arcadekit/Schedule`, `arcadekit/Stage`, `arcadekit/TickScheduler` and `arcadekit/Outbox` are gone.
  - `arcadekit` no longer exports `Build`, `Inbox`, `Loop`, `Runner`, `Schedule`, `Stage` or `Outbox`, and `TickScheduler` and `TickDispatcher` are no longer among its members.
  - `Stage.FrameChangedWorld`, what `app.frame()` and `app.input()` die with under `verifyFrames`, is `App.FrameChangedWorld`. Its `_tag` is still `"FrameChangedWorld"`.

- [#236](https://github.com/lucasthevenet/arcadekit/pull/236) [`e63ad0c`](https://github.com/lucasthevenet/arcadekit/commit/e63ad0c42e0f6a10290d13b0edd6db7a738ff972) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A fiber started during a tick ends with it. One that would still be running once the tick is over, forked with `Effect.forkDetach`, `Effect.forkIn` or into a scope of its own, would change the game at a moment no replay repeats, so the app now refuses it, and the message names the systems that were running when it started. A fiber forked with `Effect.forkChild` is interrupted with the tick as before. The app counts the fibers through `Metric.FiberRuntimeMetrics`, and still passes each start and end on to fiber metrics the game provides.

  **Breaking**

  - `app.tick` and `app.tickExit`, `app.frame` and `app.input` (and their `Exit` forms) throw when a fiber started while they ran is still running when they end.
  - `app.dispatch` and `app.dispatchByName` throw when the handler leaves a fiber running, with the handler's changes undone.
  - `App.make` dies when a plugin's `setup` leaves a fiber running.

- [#282](https://github.com/lucasthevenet/arcadekit/pull/282) [`a321750`](https://github.com/lucasthevenet/arcadekit/commit/a3217509710d205163dc6fdd59f48081ec2f603a) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A value a `json`, `ref`, `schema` or `transient` field holds reads as read-only all the way down, `Frozen<T>`, so it is replaced with `world.set` or by assigning the field in `each`, and never changed in place, which no change query would see and no refused action would undo. `Field.json<T>()` takes only a `T` that JSON holds, `JsonValue`: a `Date`, a `Map` or a class in it doesn't compile, where it came back from a save as something else.

  **Breaking**

  - `sheet.tags.push(tag)` on a field's array, or `profile.name = "x"` on a field's object, doesn't compile. Write `sheet.tags = [...sheet.tags, tag]`, or `world.set(entity, Sheet, { tags: [...] })`.
  - `Field.json<T>()` with a `T` that isn't `JsonValue` doesn't compile: use `Field.schema` for a `Date` or a class.
  - `Frozen` is in `arcadekit/ecs`, beside `JsonValue`. `Resource.Frozen` is the same type.

- [#228](https://github.com/lucasthevenet/arcadekit/pull/228) [`9ff1ad3`](https://github.com/lucasthevenet/arcadekit/commit/9ff1ad312300b9f07503b45ba219e8093e4d7336) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game lists no components and no events. Defining one is enough: a load finds each component, singleton, state and event a save or a snapshot holds by its name, among the definitions the program has. So a save of a game that forgot to list one can no longer be refused, and a plugin that adds a component can no longer break the loading of every game that uses it. A save that holds a name the program no longer defines is refused with `"unknown component"` or `"unknown event"`, and the message says a migration renames or removes it. Two definitions with one name in one world are refused, as before.

  A state moves, its first tick's enter hooks and the transitions asked for included, once a hook waits for it or the world holds it: once a value has been asked for with `set`, or a save brought it. A look at a state, from any stage, changes nothing, so a frame system that reads a state no longer makes a game differ from its replay.

  **Breaking**

  - The `components` and `events` options of `App.make`, `App.load` and `Plugin.make` are gone, and so are `Plugin.components` and `Plugin.events`. Delete the lists.
  - `Transform2d.plugin` and `Transform3d.plugin` are gone, since all they did was list the components. `Three.plugin` no longer includes them.
  - `EcsWorld.load(bytes, components)` takes its components only as the ones to prefer over the program's latest definitions, for a tool that reads a snapshot with an older build's. Leave them out otherwise.
  - A state that no hook waits for is no longer entered on the first tick of every game: it is entered on the tick after a value is first asked for. A game's hash differs from before until then.
  - `EcsWorld.holds(singleton)` is new: whether the world holds a singleton as its own, written or loaded.

- [#228](https://github.com/lucasthevenet/arcadekit/pull/228) [`e543b96`](https://github.com/lucasthevenet/arcadekit/commit/e543b96ac36dfffd5cef1c2c4f7bc9f2c56f6d24) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A resource's value is read-only: `Resource.make` types it as `Resource.Frozen<A>`, read-only all the way down, and freezes a plain object or array, as `Resource.layer` does its value. A system that changed a resource's default changed it for every app in the process, such as the next test in the same file.

  **Breaking**

  - `Resource.make` returns `Context.Reference<Resource.Frozen<A>>`, so a write to its value is a compile error, and one that gets past the compiler throws. Provide another value with `Resource.layer` instead of changing it.

- [#291](https://github.com/lucasthevenet/arcadekit/pull/291) [`a695cdc`](https://github.com/lucasthevenet/arcadekit/commit/a695cdc309f0f67bbbaa6d9dcf980a0267d15829) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - What a system, a handler or a setup is handed holds no call that compiles and then throws or does nothing. A relation's `target` is read-only in `each`, in `world.set` and in `World.writes(...).set`, so retargeting it there doesn't compile, where it threw. `Commands.spawn(ChildOf)` and `commands.add(entity, ChildOf)`, a relation with no target, don't compile, with an error that says to give it as `ChildOf.of({ target })`, and neither do they on a `CommandBuffer` or on the storage core's `World`. `world.sources(target, def)` takes only a relation, where any other component gave `[]`. A system or a handler that reads the event it emits hears it on its next run, when the entity its payload names is spawned, where it heard it at once, before that entity was there.

  `RelationDef`, the type of any relation, is exported by `arcadekit` and `arcadekit/ecs`, and `arcadekit/ecs` exports `TargetField` and `PatchOf`, the fields `set` takes.

  **Breaking**

  - A system or a handler no longer reads, in the run that emits it, an event it emitted. It hears it on its next run, as a system listed ahead of the emitter does: for a tick system, on the next tick. Code that used the event at once uses the value it emitted instead.
  - `row.target = x` in `each`, and `set(entity, Relation, { target })`, don't compile. Give the relation another target with `add(entity, Relation.of({ target }))`, on `Commands` or on the world.
  - A relation given bare to `Commands.spawn`, `Commands.add`, `CommandBuffer.spawn`, `CommandBuffer.add`, or `World.spawn` or `World.add` of `arcadekit/ecs` doesn't compile. Give it as `Relation.of({ target })`.
  - `sources` takes a `RelationDef`. A list of relations typed `ComponentDef[]` is typed `RelationDef[]` to be given to it.
  - `set` takes a `PatchOf<S>`, where it took a `Partial<ValueOf<S>>`.

- [#240](https://github.com/lucasthevenet/arcadekit/pull/240) [`c35c665`](https://github.com/lucasthevenet/arcadekit/commit/c35c665b4f2b4487c6dc0aa17a00e3ff6396a800) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The frame and input stages hear each event once across a rewind. Until the game has run again the ticks it had run before going back, an event those ticks emit again, with the same payload, isn't heard a second time: a cue doesn't play twice when rollback resimulates its tick. What the ticks now do otherwise is heard as new, and so is everything after them. This holds even when the events were dropped since the moment was captured, because the app keeps them while a moment is held.

  **Breaking**

  - A frame-stage or input-stage system no longer reads again the events of a tick a rewind runs again. One that relied on hearing them again reads the state it needs from the world.

- [#331](https://github.com/lucasthevenet/arcadekit/pull/331) [`13beba4`](https://github.com/lucasthevenet/arcadekit/commit/13beba431d1e0a23df6784f8cbe908e5859f24a0) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Input.Keyboard`, `Input.Pointer` and the new `Input.Gamepads` are services that `Input.plugin` provides. A game that reads the keyboard, the pointer or a gamepad and leaves out `Input.plugin` no longer compiles. Before, it ran, and every button read as up and every axis as 0.

  **Breaking**

  - A game that reads `Input.Keyboard`, `Input.Pointer` or `Input.Gamepad(index)` lists `Input.plugin` among its plugins, or `App.make` requires the missing service.
  - `Input.Keyboard` and `Input.Pointer` are `Context.Service` tags, no longer plain Effects. `yield* Input.Keyboard` reads the same. `Input.Gamepad(index)` returns an `Effect` that requires `Input.Gamepads`.
  - `app.read` no longer accepts them, since it provides only `World` and `Time`.

- [#221](https://github.com/lucasthevenet/arcadekit/pull/221) [`b77e120`](https://github.com/lucasthevenet/arcadekit/commit/b77e120da69818ecef6c27a8dec86955a1bc6cd5) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `app.inspect()` copies what a game holds and what it did last, as plain data to read in the console, show in a game's own UI or check in a test: every entity with its components, the singletons, every system with whether its last turn ran it and how long that took, and the events of the last tick. The storage core's `World` gains `contents()`, which copies its entities and singletons.

  **Breaking**: an object that implements `App.Any` by hand needs `inspect` too. Nothing else changes.

- [#527](https://github.com/lucasthevenet/arcadekit/pull/527) [`2734f7d`](https://github.com/lucasthevenet/arcadekit/commit/2734f7db9791f7a40c659c284040b4e9c8b7c1b3) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Timeline.keep` captures the game when a move arrives, before the tick or the dispatch that applies it, and a tick with no move captures nothing. A game that ticks by itself at rest no longer captures itself 60 times a second: a tick of a clock and 1,000 pieces at rest cost 4.2 µs with its turns kept and 1.6 µs without, and now costs what it does without.

  - A redo of a turn that the rules went back, with a `Timeline.Undo` that a system or a handler enqueued, stays where it went. It used to go to the game with that undo still queued, which the next tick applied again.
  - A game that can't be captured dies with keep's error when a move arrives, in the enqueue, the dispatch or the input stage that issued it, where it died in the tick after.

  Nothing a game writes breaks.

- [#461](https://github.com/lucasthevenet/arcadekit/pull/461) [`ac76555`](https://github.com/lucasthevenet/arcadekit/commit/ac76555077f841c45334621ffdcd30cbfa31dc6d) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game's levels can be files. `Assets.family("game/Level", (level: number) => ({ layout: Assets.json(`/levels/${level}.json`, Layout) }))` makes a bundle for each level's number, `Levels.of(3)`, the same bundle each time. `Assets.during(key, family)` keeps the bundle of the key the game is at loaded, such as `Assets.during(Effect.map(Progress, ({ level }) => level), Levels)`, and lets go of the one before when the key changes. A game adds a level by adding its file.

  `Assets.onReady(bundle, rules, payload)`, and `Assets.onReady(family, key, rules, payload)` for a family, is a plugin that hands a loaded bundle to the rules: an input-stage system issues an action with a payload made from its assets, and `rules`, the game's own `Action.handler`, applies it. The world records what it was handed, by the bundle's or the family's name, with the family's key, so a save, a rewind and the hash hold the record. `rules` runs once for each handover the world records: a level whose file spawns nothing is handed over once, an app made from a save doesn't hand its level over again, a rewind to before a handover hands it over again once, and going from level 1 to level 2 and back hands each over as the game comes to it. In a session every peer whose bundle loads issues the handover, the first one applied counts on every peer, and a peer whose bundle fails to load holds nobody up. `Assets.forget(bundle)`, in code of the tick, makes the world forget a handover, so that the bundle is handed over again, as when a new run starts.

  Nothing breaks. The example page's `Begin` system, which checked that the sky was empty before it issued the action, is `Assets.onReady(Level, scatter, ({ layout }) => layout)`, and `Start` forgets the level so that a new game is handed it again.

- [#164](https://github.com/lucasthevenet/arcadekit/pull/164) [`d45e1a7`](https://github.com/lucasthevenet/arcadekit/commit/d45e1a7d264c7a901568ea6f73fbf1adc08bd32a) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - No export takes or returns `any`. What stands for any component, singleton, event, state, system, plugin, action or handler says what it is: `ComponentDef`, `SingletonSpec`, `EventDef<unknown>`, `State<string>`, `System<unknown, unknown>`, `Plugin.Any` (of `unknown`s), and the new `Action.AnyActionDef` and `Action.AnyHandler`, whose payload is `never`. `System.GenError` and `System.GenServices` are new: what a generator's effects fail with and need, as `Effect.gen` says it, which `System.make`, `Sound.music` and `View.publish` now return. `Driver.interval` beats on Effect's `Clock`, so a `TestClock` moves it on. The default `Assets.Loader` asks through Effect's `HttpClient`, over `fetch`.

  **Breaking**

  - `Migrate.mapField`'s `map` names the type of the old value: `(hp: number) => hp / 2`, where `(hp) => hp / 2` took it as `any`.
  - A list typed as `Plugin.AnySystem[]` or `Plugin.AnyHandler[]` and given to `App.make` makes the app need `unknown`, where `any` let it run. Type the list with what its systems need, `System.System<never, World | Time>[]`, or pass the systems themselves.
  - `ComponentDef.of`, `EventHandle.emit`, `StateHandle.is` and `StateHandle.set` are typed as methods, so that a component, an event or a state of any type is one of the types above. They work as before; a game that lints with `typescript/unbound-method` is told about one taken off its object.
  - `Sound.cues`, `Three.instances` and `Three.objects` are overloaded functions, with the same two signatures each.
  - `Three.ColorComponent`'s `r`, `g` and `b` are `FieldDef<number, unknown>`.
  - The default `Assets.Loader` resolves a path against the page's `location`, not its `<base href>`, and a file the server refused says `The server answered 404`, without the status text.

- [#207](https://github.com/lucasthevenet/arcadekit/pull/207) [`47d487a`](https://github.com/lucasthevenet/arcadekit/commit/47d487ac5893a67f0b6ced1715857ae2c35e07e4) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A save's waiting events are decoded with their schemas as it is loaded, and a save that holds one in a form its schema no longer takes is refused with `"event changed"`, where the event threw when a system first read it. For that, a plugin lists the events a save may hold in `events`, as it lists components, and the app takes `events` too.

  **Breaking**

  - An event that may be waiting to be read when the game is saved is listed in a plugin's `events`, or the app's: `Plugin.make("Combat", { components: [Health], events: [Struck] })`. Saving while an unlisted event is waiting fails with `Save.SaveRefused`, and loading a save that holds one fails with `Save.LoadRefused`, problem `"unknown event"`.
  - Listing an event defined with a type and no schema throws when the app is made.
  - `Save.LoadRefused`'s `problem` has two more values, `"unknown event"` and `"event changed"`.
  - `Event.EventsMoment` has no `parked`: no event of a save waits for its definition any more.

- [#469](https://github.com/lucasthevenet/arcadekit/pull/469) [`e1081e9`](https://github.com/lucasthevenet/arcadekit/commit/e1081e9bc2c2dc824413817f921fb9ea400bf31e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - An app loads a save in place, a save is kept in a slot, and a setting is kept outside the world.

  ```ts
  Effect.gen(function* () {
    yield* Save.write("slot2", yield* app.save()); // kept in Save.Store
    const saved = yield* Save.read("slot2"); // an Option
    if (Option.isSome(saved)) {
      yield* app.load(saved.value); // the same app, its layers, stages and driver
    }

    const Volume = Setting.define("game/Volume", Schema.Number, 1);
    yield* Setting.set(Volume, 0.5); // kept in Setting.Store, through a reload
  });
  ```

  - `app.load(save)` puts the game a save holds into the app that runs, as `App.make(game, { save })` would make it, and fails with `Save.LoadRefused`, leaving the app as it was, for a save the game can't load. Its log starts over, and `Timeline.rewind` refuses a moment captured before the load.
  - `Save.Store`, provided with `Save.layer(store)`, keeps saves by slot: `Save.write` and `Save.read`, which fail with `Save.StoreFailed`. `Browser.saves(name)` keeps them in a page's local storage, and `Save.makeMemory()` in memory for a test.
  - The new module `arcadekit/Setting`: `Setting.define(key, schema, initial)`, read with `yield*` in the frame and input stages and never in a tick, and `Setting.set`, which fails with `Setting.Invalid` or `Setting.StoreFailed`. `Setting.Store` keeps them, with `Setting.layer(store)`, `Browser.settings(name)` and `Setting.makeMemory()`.
  - The guide to snapshots is a page of its own, and settings have one.

  **Breaking**

  - `App.Steered`, the app a session steps, has no `load`.

- [#296](https://github.com/lucasthevenet/arcadekit/pull/296) [`afc6a22`](https://github.com/lucasthevenet/arcadekit/commit/afc6a22487442a164234b271b87850b99b4013c9) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A session is told this peer apart from the others: `Session.make(game, { seed, me: "ada", others: ["grace"], delta })`. A peer not among the peers of its own session can no longer be written, and a name given twice, as `me` and among `others` or twice among `others`, doesn't compile when the names are literals: the error says which name. `Session.Repeated<Me, Others>` is that message at the type level. Names the compiler knows only as `string` are still refused when the session is made.

  **Breaking**

  - `Session.Options` has `me` and `others` in place of `peer` and `peers`. Replace `{ peer: "ada", peers: ["ada", "grace"] }` with `{ me: "ada", others: ["grace"] }`: `others` is every peer but this one.
  - A session's `peer` is `me`. Its `peers` is unchanged: every peer, this one too, in the order their actions are applied.
  - The refusal of a peer that isn't among `peers` is gone, since it can't be written. A name given twice throws with a new message, which names `me`.
  - `Session.Options` takes two more type parameters, `Me` and `Others`, after `SV`, both defaulting to any names.

- [#207](https://github.com/lucasthevenet/arcadekit/pull/207) [`2448aee`](https://github.com/lucasthevenet/arcadekit/commit/2448aeecd8747de487edd4d2653fc8bdf77cda68) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Migrate.addField` and `Migrate.mapField` refuse a value that a field of a number type cannot hold, where they stored what its typed array made of it.

  **Breaking**

  - A migration that gives a number field anything but a number, a fraction to a whole-number field, or a number out of its range (300 to a `u8`) throws, and the save is refused with `"migration failed"` and the field's name. It used to store NaN, the number a string parses to, or the number cut to fit.
  - The compiler refuses a value that is not a number for a field of a number type: `addField`'s value and what `mapField`'s function returns are `Migrate.ValueOfKind<K>`. A migration that returned `unknown` for one, such as `(v) => v`, names the old value's type: `(v: number) => v`.

- [#472](https://github.com/lucasthevenet/arcadekit/pull/472) [`b2c81b0`](https://github.com/lucasthevenet/arcadekit/commit/b2c81b0a85cbae528843dcb5bf6587c3a597c6a0) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A save is migrated in one module, `Migrate`, by definitions: a step names what the game has now by its definition, and what it no longer has by its old name, and carries the events waiting to be read, the actions queued and the states with their scoped entities, as it does components.

  ```ts
  const migrations = [
    Migrate.step(1, (save) => {
      save.renameComponent("game/Hp", Health);
      save.addField(Health, "max", 10); // a field of Health's, of its kind
      save.renameEvent("game/Hit", Struck);
      save.mapPayloads(Move, (payload) => ({
        ...(payload as Move0),
        run: false,
      }));
      save.renameStateValue(Phase, "play", "playing"); // its scope tag with it
    }),
  ];
  ```

  `Migrate.Contents` has `renameComponent`, `removeComponent`, `renameField`, `addField`, `removeField`, `mapField`, `renameEvent`, `removeEvent`, `renameAction`, `removeAction`, `mapPayloads`, `renameState` and `renameStateValue`. A field the definition doesn't have doesn't compile. A load refused for a name a save holds says which of them to use.

  **Breaking**

  - `Save.Migration`, `Save.migrate` and `Save.Contents` are `Migrate.Migration`, `Migrate.migrate` and `Migrate.Contents`, and `{ from, migrate: (contents) => ... }` is `Migrate.step(from, (save) => ...)`.
  - The functions of `Migrate` that took the save's world and names are the methods of the save a step is given, which take definitions: `Migrate.renameComponent(world, "game/Hp", "game/Health")` is `save.renameComponent("game/Hp", Health)`, and `Migrate.addField(world, "game/Health", "armor", "i32", 0, "points")` is `save.addField(Health, "armor", 0)`, of the kind and at the place `Health` gives it.
  - `Save.VISITS` is gone: `renameComponent` renames what change queries had yet to visit, and nothing else of a game names it.

- [#516](https://github.com/lucasthevenet/arcadekit/pull/516) [`146aaf4`](https://github.com/lucasthevenet/arcadekit/commit/146aaf4355bb80ed149e469b80f7e284987a8cab) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - An action and a plugin offer a game only the members it reads. `Action.Action` has no `_P`: its own `in out P` keeps an action from passing for one of another payload. `Plugin.Plugin` has no `_types`: it carries its types under a key that no game can name, and an editor doesn't offer it.

  **Breaking**

  - A type that read `_P` of an action, or `_types` of a plugin, reads the same types another way. For a plugin, it uses `Plugin.TickErrorOf`, `Plugin.HandlerOf`, `Plugin.ProvidedOf`, `Plugin.ErrorOf`, `Plugin.LayerNeedsOf` or `Plugin.NeedsOf`. For an action, it uses `T extends Action.Action<infer N, infer P, infer E>`.

- [#228](https://github.com/lucasthevenet/arcadekit/pull/228) [`b5261e7`](https://github.com/lucasthevenet/arcadekit/commit/b5261e7d11b47c1ce8ae7a6c88ff14b23b81f49e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Scripts are gone. What a game is in the middle of keeps its place in the world, in a component, a singleton or a state, and a system moves it on each tick. So a save, a moment, a replay and the world's hash all see it, and nothing that runs across ticks can be lost by a load, restarted by a rewind, or left out of the log. A system or a handler that waits still throws, and the message says where the work goes instead.

  **Breaking**

  - `Script`, `app.spawnScript`, the `scripts` of `Plugin.make`, an event's `wait`, `App.make`'s `onScriptFailure` and `App.ScriptFailed` are removed. Keep a script's progress in the world, and move it with a system: a countdown in a singleton for `sleep`, a system that reads an event for `wait`. See "Work that takes many ticks" in the systems guide.
  - `app.save()` and `app.capture()` no longer refuse because a script is running.
  - `App.App` takes two type parameters, `App<E, HU>`: the services its systems need were there only for scripts.

- [#216](https://github.com/lucasthevenet/arcadekit/pull/216) [`c4d06d8`](https://github.com/lucasthevenet/arcadekit/commit/c4d06d8d3130b330fb80e52f67dd94ce3d46a433) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Systems no longer declare what they read and write. A system runs in the order it is listed and as `System.after` and `System.before` say, the same on every run, so nothing in a game needs its access. `Query.reads` stays: it makes a query's terms read-only and keeps a raw loop from counting as a write to them.

  **Breaking**

  - `System.access`, `System.accessOf`, `System.conflicts` and their types `Access`, `Touch`, `Touched`, `Resolved`, `Conflict` and `Report` are removed. Drop `.pipe(System.access({ ... }))` from a system.
  - `app.conflicts` and `app.undeclared` are removed. A test that asserted `app.conflicts` is empty drops the assertion.
  - The world's guard is removed: `world.guard` and the `Guard` type of the storage core. Nothing refuses what a system touches any more.

- [#228](https://github.com/lucasthevenet/arcadekit/pull/228) [`2f343e9`](https://github.com/lucasthevenet/arcadekit/commit/2f343e9c4d08bac1c0c37f1142e513df56d6c747) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `app.enqueue` and `Actions.enqueue` are one function, and where it is called decides whether the action is logged. From a tick, a handler, a script or a plugin's setup it is the simulation's own move and isn't logged; between ticks, the frame and input stages included, it is input and is logged. A system or a handler that holds the app and calls `app.enqueue` no longer logs its move, which a replay applied twice. `app.enqueueByName` follows the same rule.

  **Breaking**

  - `app.enqueue` and `app.enqueueByName` called during a tick or from a handler no longer log the action, and don't send it to the other peers of a session: every peer's simulation issues it. `app.enqueue` returns `Exit.void` there without checking the payload against the schema, as `Actions.enqueue` always did.
  - `app.enqueueByName` with an issuer, `from`, throws when called by the simulation.

- [#238](https://github.com/lucasthevenet/arcadekit/pull/238) [`eb9f830`](https://github.com/lucasthevenet/arcadekit/commit/eb9f8301969182792ee8954cf12aaf0dbe68796c) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game is recorded as one value that says how it was played. `app.record()` returns an `App.Recording`: the action log, the ticks it begins and ends at, and the delta of every tick, kept as runs of ticks that took the same delta. `App.replay(app, recording)` takes nothing else, so a replay can't be given the wrong tick length or stop short. It throws when the app isn't at the recording's first tick. `app.record(save)` records since a save of the app, for an app loaded from that save to replay. `App.encodeRecording` and `App.decodeRecording` turn a recording into text and back, and decoding refuses one whose log or runs of deltas are out of order or outside it.

  **Breaking**

  - `App.replay(app, log, { delta, ticks })` is now `App.replay(app, app.record())`. For the tail since a save, `App.replay(loaded, app.record(save))` replaces `App.replay(loaded, app.actionLog.slice(save.logLength), { delta, ticks })`.
  - `Action.encodeLog` and `Action.decodeLog` are removed. Use `App.encodeRecording` and `App.decodeRecording`, which write and read the whole recording.

- [#455](https://github.com/lucasthevenet/arcadekit/pull/455) [`bb47fbd`](https://github.com/lucasthevenet/arcadekit/commit/bb47fbd1a1d9d224cc93013ef41426f5c2914c7c) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Every module names its types and errors by one rule. A module's main type is its name, and every other type is named for what it is after the namespace, which it does not repeat. A service's interface is the service's name and `Shape`. An error's class is named for what went wrong, and its tag is its module and its class together, so `Effect.catchTag` never takes two errors of one bare tag for one. A codec's `decode` fails with a tagged error of its module that has a `problem`, and its `encode` fails the same way and does not throw. The Oxlint rule `arcadekit/names` holds the names and the tags.

  **Breaking**

  Types:

  - `Event.EventDef` is `Event.Event`, `Event.EventReader` is `Event.Reader`, and `Event.EventHandle` is `Event.Emitter`.
  - `Action.ActionDef` is `Action.Action`, and `Action.AnyActionDef` is `Action.Any`.
  - `State.StateView` is `State.Reader`, and `State.StateHandle` is `State.Setter`.
  - `ComponentDef` and `RelationDef` of `arcadekit` are `Component.Component` and `Component.Relation`. `arcadekit/ecs` keeps `ComponentDef` and `RelationDef`.
  - The interface of `Input.Source` is `Input.SourceShape`, and that of `Sound.Output` is `Sound.OutputShape`.
  - `Sound.Line` is `Sound.Binding`, `Sound.Options` is `Sound.PlayOptions`, and `Sound.Scored`, what a recorder notes of a channel, is `Sound.Told`.
  - `Driver.Ready` is `Driver.ReadyOptions`, `Three.Which` is `Three.KindOptions`, `Audio.AudioLike` is `Audio.ContextLike`, and `Transport.WireTransport` is `Transport.OverWire`.

  Errors, with the tag `Effect.catchTag` takes:

  - `Save.SaveRefused` is `Save.Refused`, still `"SaveRefused"`. `Save.LoadRefused` is `"SaveLoadRefused"`, and its `problem` is never `"world not empty"` or `"cannot be saved"`: a migration that leaves a value that can't be saved is `"migration failed"`.
  - `Action.UnknownAction` is `Action.Unknown`, `"ActionUnknown"`, and `Action.InvalidPayload` is `"ActionInvalidPayload"`. A refused entry of an app's log says these tags.
  - `Assets.AssetFailed` is `Assets.Failed`, `"AssetsFailed"`, and `Event.InvalidEvent` is `Event.Invalid`, `"EventInvalid"`.
  - `Drift.Drifted` is `"DriftDrifted"`, `Drift.Unlike` is `"DriftUnlike"`, `Session.RewindDiverged` is `"SessionRewindDiverged"`, `Journal.HashMismatch` is `"JournalHashMismatch"`, `Journal.ReplayDiverged` is `"JournalReplayDiverged"`, and `App.FrameChangedWorld` is `"AppFrameChangedWorld"`.

  Codecs:

  - `Journal.encode` returns an `Exit` and fails with `Journal.Invalid`, `"no JSON form"`, where it threw: `yield* Journal.encode(recording)`. `Journal.decode` fails with `Journal.Invalid`, `"not a recording"` or `"older format"`, where it failed with a `Schema.SchemaError`.
  - `Message.encode` returns an `Exit` and fails with `Message.Invalid`, `"not a message"`, where it threw. `Message.decode` and `Message.decodeNotice` fail with `Message.Invalid` where they failed with a `Schema.SchemaError`.

- [#262](https://github.com/lucasthevenet/arcadekit/pull/262) [`f751434`](https://github.com/lucasthevenet/arcadekit/commit/f75143465b9075f5b7c405731fcc48973f780597) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - There is one session, and it makes its app. `Session.make(game, { seed, peer, peers, delta })` takes the game, as `App.make` does, and returns a session whose `app` it steps. `ahead` says how many ticks it runs past what every peer has sent, 8 by default, and `ahead: 0` is lockstep. `session.app` is an `App.Steered`: an app without `tick`, `tickExit`, `dispatch` and `dispatchByName`, so stepping a session's app yourself doesn't compile, where it threw.

  What breaks:

  - `Lockstep` and `Rollback` are gone. `Lockstep.make(app, options)` is `Session.make(game, { ...start, ...options, ahead: 0 })`, and `Rollback.make(app, options)` is `Session.make(game, { ...start, ...options })`, where `start` is what the app was made with: its `seed` or `save`, `checkpointEvery`, `verifyFrames`. The game's code reaches the app as `session.app`.
  - `delay` defaults to 0, and to 2 for a session whose `ahead` is 0: what the two modules defaulted to.
  - `Rollback.syncTest(app)` is `Session.syncTest(game, start)`, an effect, and its app is `test.app`. `Rollback.RewindDiverged` is `Session.RewindDiverged`.
  - What peers say to each other is `arcadekit/Netcode`: `Lockstep.Message`, `Lockstep.Issued`, `Lockstep.encode`, `Lockstep.decode` and `Lockstep.Drifted` are `Netcode.Message`, `Netcode.Issued`, `Netcode.encode`, `Netcode.decode` and `Netcode.Drifted`. A transport and a relay import it, and no app with it.
  - `app.divert` and `App.Diverted` are gone from an app. Taking an app over is `Build.build(game, start)`, which returns the app with `take`, and `App.Diverted` is `Build.Reins`. A session is the only thing in the package that takes one over.
  - `Lockstep.Session` and `Rollback.Session` are `Session.Session`, whose `tickExit` can fail with `Save.SaveRefused` whatever its `ahead`.
  - The guide "Lockstep and rollback" is "Sessions", at `/guides/sessions`.

- [#459](https://github.com/lucasthevenet/arcadekit/pull/459) [`49fab38`](https://github.com/lucasthevenet/arcadekit/commit/49fab38a9648635ed2383087de8d9bc01149a436) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Every service a program provides from outside an app has one shape: its key is the entry it is imported from and its name, `X.layer(implementation)` provides it, and its module makes the stand-in a test provides in its place. A new module, `arcadekit/Test`, makes a game's app with those stand-ins and hands them back beside it:

  ```ts
  Effect.gen(function* () {
    const game = yield* Test.make(Rogue, {
      seed: 7,
      files: { "/one.json": level },
    });
    game.input.press("KeyW");
    yield* game.step(); // the input stage, one tick, the frame stage
    yield* game.rest(); // steps until the app is settled
    game.sound.played;
    game.ui.get(Hud);
  });
  ```

  `Driver.layer(display)`, `Assets.layer(loader)` with `Assets.makeMemory(files)`, and `Three.layer(renderer)` with `Three.makeRecorder()` are new. The entries' tests of both packages hold every service to the shape.

  **Breaking**

  - `Assets.layerMemory(files)` is `Assets.layer(Assets.makeMemory(files))`.
  - `View.layer(game, mount)` is `View.mount(game, mount)`: it provides nothing a system asks for.
  - A hub has no `layer`: `hub.layer(peer)` is `Transport.layer(hub.port(peer))`.
  - A renderer made by hand is `Three.layer({ render(scene, camera) {} })`, where it was `Layer.succeed(Three.Renderer, ...)`, and a test records what is drawn with `Three.makeRecorder()`.
  - The keys of the services are their entries and names, so a service of a game's own never takes one: `"arcadekit/World"` is `"arcadekit/Services.World"`, and so for `Sim`, `Time`, `Frame`, `Commands`, `Events` and `Random`; `"arcadekit/Actions"` is `"arcadekit/Action.Actions"`, `"arcadekit/Display"` is `"arcadekit/Driver.Display"`, `"arcadekit/Transport"` is `"arcadekit/net/Transport.Transport"`, and `"arcadekit/three/Scene"` and `"arcadekit/three/Renderer"` are `"@arcadekit/three/Scene.Scene"` and `"@arcadekit/three/Renderer.Renderer"`.

- [#252](https://github.com/lucasthevenet/arcadekit/pull/252) [`40e1d13`](https://github.com/lucasthevenet/arcadekit/commit/40e1d138513efe69acb91a6988e1e68c407ee9f2) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - An event is emitted by the simulation alone: a system of the tick, an action's handler or a plugin's setup. `app.events.emit()` and a handle's `emit` throw from anywhere else, where they added an event that no log held, so that a replay of the game and its other peers went on without it.

  What the frame and input stages hear is a module of its own, `arcadekit/Outbox`, where it was part of `Event`.

  **Breaking**

  - `app.events.emit(event, payload)` from outside the simulation throws. Dispatch or enqueue an action whose handler emits the event.
  - A handle a system kept, used once the system has run, throws on `emit`.

- [#327](https://github.com/lucasthevenet/arcadekit/pull/327) [`3bf76af`](https://github.com/lucasthevenet/arcadekit/commit/3bf76af15b5a106be58cb218bb57907e744827a9) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Code outside the game that reads an event hears across a rewind what the frame and input stages hear. It used to skip every event told between a rewind and its next read, so a UI or a sound that listened that way missed them. Now its next read returns what was told since the moment the rewind went back to, and after a rewind with `again`, each event of the ticks run again once.

  **Breaking**

  - A handle that outside code reads no longer skips to the newest event after a rewind. Code that relied on that skip reads the state it needs from the world instead.

- [#267](https://github.com/lucasthevenet/arcadekit/pull/267) [`cfa1292`](https://github.com/lucasthevenet/arcadekit/commit/cfa1292f2a5609dca715d7d264008291ed18511f) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Peers compare what they were made with before anything else. A session's first message says it, as `made` (`Message.Made`): a hash of what its game simulates (the systems of the tick in the order they run, the hooks of its states, the actions it handles, its version), its `delta`, the names of every peer, and the tick it begins at. A peer that hears another made otherwise stops with `Drift.Unlike`, which names both peers, what each was made with, and `differ`, what differs, before it runs a tick it is sure of. A different `delta`, a system one peer lacks or a different list of names was found only once it had changed a world; a list that left a peer out, and peers that began at different ticks, were never found, and the peers waited.

  What breaks:

  - `Drift.make({ peer, peers, start })` is `Drift.make({ peer, made })`, where `made` holds the peers and the start, and its comparison has `told(from, made)`.
  - `session.drifted`, `session.tickExit`'s failure and `Comparison.drifted` can be `Drift.Unlike` as well as `Drift.Drifted`.
  - A peer whose game simulates otherwise, by the names of its systems, hooks and handlers, no longer plays with the others. One that only draws, plays sound or reads its devices otherwise still does.

- [#454](https://github.com/lucasthevenet/arcadekit/pull/454) [`054a34c`](https://github.com/lucasthevenet/arcadekit/commit/054a34c34e2ad3273f35ed15e9aa5feadc5ee56f) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A module gives what a game uses and nothing else. What its own code needs is in `src/internal/`, so `State.`, `Save.`, `System.` and the rest offer only their public names, and what a system yields has no member a game must not call. The Oxlint rule `arcadekit/no-unused-internal` refuses an `@internal` export, or an `@internal` member of a public export, in the file of an entry. `arcadekit` gives the world's two types, `ReadingWorld` and `WritingWorld`, with the rest of `Services`, and a `Component` module of its own, `arcadekit/Component`, with `define`, `relation` and `tag`.

  **Breaking**

  - `State.defined`, `State.Registry`, `State.registryOf`, `State.handleOf`, `State.pending`, `State.enter`, `State.despawnScoped`, `State.refuseRemovedScopes` and `State.prepare` are gone from `State`, and so is a state's `scopes`. `State.scoped(state, value)` gives a value's tag.
  - `Save.taking`, `Save.take`, `Save.versionOf`, `Save.into`, `Save.singleton`, `Save.VisitsData` and `Save.Visits`, `System.raw`, `System.triggered`, `System.spanLevel`, `System.unique` and `System.order`, `Action.said`, `Action.QueuedAction`, `Action.jsonOf` and `Action.Intake`, `Assets.fetching` and `Assets.fetchingFrom`, `Event.Emitted` and `Event.EventBus`, `Journal.Since` and `Journal.Log`, `Plugin.flatten`, `View.Intake`, and `Peer.Options`, `Peer.PeerApp` and `Peer.build` are gone. None of them was for a game.
  - `Sound.PlayerShape` has no `_begin` and no `_flush`, and `Three.SceneShape` no `_kept` and no `_owned`. `Sound.plugin` and `Three.plugin` keep them to themselves.
  - `import { EcsWorld, CommandBuffer, SnapshotError, readSnapshot, writeSnapshot } from "arcadekit"` is gone. A program of the storage core imports them from `arcadekit/ecs`: `import { World, CommandBuffer, SnapshotError, readSnapshot, writeSnapshot } from "arcadekit/ecs"`. The storage core's types stay in `arcadekit`.
  - `Component` of `arcadekit` is the module `arcadekit/Component`, which has no `singleton`. A game defines a singleton with `Singleton.define(name, schema, initial)`. `Component.singleton` stays in `arcadekit/ecs`.
  - `Browser.sound`, `Browser.stream`, `Browser.layerSound`, `Browser.AudioLike` and `Browser.MediaLike` are gone: they are `Audio.sound`, `Audio.stream`, `Audio.layerSound`, `Audio.AudioLike` and `Audio.MediaLike`, of `import { Audio } from "arcadekit/browser"`.

- [#368](https://github.com/lucasthevenet/arcadekit/pull/368) [`b4fd6ce`](https://github.com/lucasthevenet/arcadekit/commit/b4fd6cee23a25d2ff1b8d66cec2f3293572273af) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Query.maybe` makes a term of `Query.all` that an entity may lack: `Query.all(Position, Query.maybe(Rotation), Query.maybe(Scale))` visits every entity with a `Position`, and hands its loop the rotation and the scale where the entity's table has them, and `undefined` where it doesn't. `each` passes an accessor or `undefined`, and `eachChunk` the columns or `undefined` for a whole run, so a loop tests once per run in place of one query for each combination. It takes only a component stored in tables, and `Query.changed` and `Query.added` don't take it.

  `Three.instances` and `Three.objects` each draw a kind with one such query, where they used up to eight and three. Instances of a kind may now be filled in another order, which nothing promised.

  Nothing breaks.

- [#228](https://github.com/lucasthevenet/arcadekit/pull/228) [`44f02e9`](https://github.com/lucasthevenet/arcadekit/commit/44f02e94ac01f9f7d37a6357d43bc953c9b08cf6) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A query only reads its terms, unless `Query.writes` names the ones it writes: `Query.all(Position, Velocity).pipe(Query.writes(Position))`. The compiler refuses an assignment to a term the query doesn't name, through `each` or a raw column of `eachChunk`, and an assignment through `each` throws at run time. So a loop that only reads no longer counts as writing for the change queries that watch what it reads, and a handler that only looks no longer copies the columns it reads, without anyone having to remember to say so.

  **Breaking**

  - `Query.reads` is gone. A query reads what it doesn't name in `Query.writes`: delete `Query.reads(...)`, and add `Query.writes(...)` with the terms the loop writes.
  - A system that writes through a query without `Query.writes` no longer compiles, and throws at run time when it assigns through `each`. Name what it writes.
  - `Query.Reading<D, R>` is now `Query.Reading<D>`, every term marked read-only, and `Query.Writing<D, W>` unmarks the terms in `W`.
  - A save keeps a change query's position under a description that includes what it reads. A change query that now reads a term it used to write is another query to a save made before this change, and starts by visiting everything.

- [#281](https://github.com/lucasthevenet/arcadekit/pull/281) [`5b630ce`](https://github.com/lucasthevenet/arcadekit/commit/5b630cee8bd6cf6375d9b900c121564d9cb015cc) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Code outside a game reads it with `app.read(effect)` and changes it with an action alone. `app.read` runs an effect that requires `World` and `Time` and nothing else, so a query that only reads, a singleton and a state's value are read the same way, and an effect that requires `Commands`, `World.writes`, a query that writes or watches, an event, `State.sets` or `Singleton.writes` doesn't compile. Everything that changes a game from outside is then in its log, and a replay reproduces it.

  **Breaking**

  - `app.world`, `app.commands`, `app.events` and `app.dispatcher` are gone from `App.Any`, `App.App` and `App.Steered`.
  - Read the world with `const world = yield* app.read(World)`: it has `get`, `has`, `isAlive`, `sources`, `singleton`, `holds`, `entityCount` and `hash`. It stays current, so read it once and keep it.
  - `app.world.view(query)` is `yield* app.read(query)`, for a query with no `Query.writes`, `Query.changed` or `Query.added`. `app.world.singleton(Score)` is `yield* app.read(Score)`.
  - What a game starts with is spawned by a plugin's `setup`, which a replay runs too. `app.world.spawn`, `set`, `add`, `remove` and `despawn` between ticks are an action whose handler makes the change, issued with `app.enqueue` or `app.dispatch`.
  - `Timeline.Game` is `Pick<App.Any, "phase" | "time">`. `Timeline.capture` and `Timeline.rewind` take an app that `App.make` made, and throw for anything else.

- [#340](https://github.com/lucasthevenet/arcadekit/pull/340) [`30c7df1`](https://github.com/lucasthevenet/arcadekit/commit/30c7df11df12640a5bd3652a0e8a68c099c6394a) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - An app made with `verifyFrames` refuses a write through a raw column that `eachChunk` hands out read-only, in every stage, the tick and an action's handler as much as the frame. Before, outside the frame and input stages, nothing saw it. `eachChunk` copies each such column, the fields of a term the query only reads and a relation's `target`, and compares it when the loop returns. A loop that changed one throws, naming the component and field, and the column is put back, so the world, its hash, its change queries and a refused action's rollback are as if the write was never made. It costs a copy and a comparison of each column handed out read-only, in an app made with `verifyFrames` and nowhere else.

  **Breaking**

  - With `verifyFrames`, a write through a raw column in the frame or input stage throws from `eachChunk`, and no longer dies with `Stage.FrameChangedWorld`. That error is left for a draw from `world.random`, and for a change a cast let through any other way.
  - With `verifyFrames`, a tick system or an action's handler that writes a raw column it was handed read-only now throws, where the write went through.

- [#495](https://github.com/lucasthevenet/arcadekit/pull/495) [`ffbbcd3`](https://github.com/lucasthevenet/arcadekit/commit/ffbbcd36b8ddf28d8af754d05a17b5dc015b3a00) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game that ticks by itself keeps its redo until the next move. `Timeline.redo` and the action `Timeline.Redo` go forward after the ticks a game runs at rest, where they used to find nothing one tick after the undo.

  - A move, a load or a rewind gives up every turn ahead. A tick that applies no move from outside gives up none, and neither does an undo or a redo with no turn to go to.
  - A redo puts the game as it was at the undo, its time with it, and gives up the ticks run since.

  Nothing a game writes breaks. A redo after ticks at rest now succeeds with `true` and goes forward, where it succeeded with `false`.

- [#386](https://github.com/lucasthevenet/arcadekit/pull/386) [`22032d9`](https://github.com/lucasthevenet/arcadekit/commit/22032d9ec757b83cd895c19db01f7751e40482ea) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - An action declares the schema of its error in `Action.define(name, { payload, error })`, as `Rpc.make` does, and `Action.rejected(action)` reads the refusals of one action with its payload and error typed, the same on every peer and across a save.

  **Breaking**

  - A handler fails only with the error its action declares. Without `error`, the error is `Schema.Never` and the handler can't refuse the action. A handler that failed with a `Data.TaggedError`, a string or any other undeclared error no longer compiles: make the error a `Schema.TaggedError` and declare it, `{ error: NotYourTurn }`, or `{ error: Schema.Union([NotYourTurn, TooTired]) }` for several. The schema's values and encoded form have a `_tag`.
  - `Action.Rejected`'s `error` is the refusal in its JSON form, `{ _tag, ...its fields }`, where it was `{ _tag, message }`. It has a `message` only when the error's schema declares one.
  - A queued action whose handler dies, is interrupted, or fails with an error its action doesn't declare no longer becomes an `Action.Rejected`: what it did is undone, and the tick fails, so `app.tick` throws, as it does for a system that fails.
  - `Action.InvalidPayload` and `Action.UnknownAction` are `Schema.TaggedError` classes, with the same fields.
  - `Action.ActionDef` has a third type parameter, the error, and the fields `error`, the error's codec, and `rejected`. An action is made with `Action.define`.

- [#207](https://github.com/lucasthevenet/arcadekit/pull/207) [`0e63aa7`](https://github.com/lucasthevenet/arcadekit/commit/0e63aa7ee3a1d51c8d520a200ecc06002671ad04) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `app.enqueue` refuses a payload its action's schema does not take where it is called, in a game of one and of several peers alike, where it queued it to be refused when its turn came, on the issuing peer alone.

  **Breaking**

  - `app.enqueue` returns `Exit<void, Action.InvalidPayload>`, which fails, with nothing queued or logged, for a payload the schema refuses. Such a payload used to become an `Action.Rejected` event at the start of the next tick; a game that showed that refusal reads the `Exit` instead.
  - A system of the frame or input stage that issues such a payload with `Actions.enqueue`, as an input binding does, throws.

- [#172](https://github.com/lucasthevenet/arcadekit/pull/172) [`4297ae0`](https://github.com/lucasthevenet/arcadekit/commit/4297ae0d7deb89133c3ebeb2450c93c1dce6e1a0) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A state's handle and `Gltf.model` refuse, with a message that says what is wrong, what they used to pass on unchecked.

  **Breaking**

  - A state's handle throws on reading a value that is not one of the state's values, as a save from an older game can hold, where it returned that value. A migration renames a state's values in a save.
  - `Gltf.model` fails with `Assets.AssetFailed` for a document whose `buffers`, `bufferViews` or `images` are not lists of what glTF has there, where it went on with them.

- [#282](https://github.com/lucasthevenet/arcadekit/pull/282) [`3683e37`](https://github.com/lucasthevenet/arcadekit/commit/3683e375396bfc4baab888a71491ced3030e69aa) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Query.removed(X)` puts `WatchesRemoved<"X">` in what a system requires, as `Query.changed` and `Query.added` put theirs, so `app.read` doesn't take it: which removals a reader has read is the game's.

  **Breaking**

  - `app.read(Query.removed(X))` doesn't compile. Read removals in a system.

- [#282](https://github.com/lucasthevenet/arcadekit/pull/282) [`3683e37`](https://github.com/lucasthevenet/arcadekit/commit/3683e375396bfc4baab888a71491ced3030e69aa) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game that ticks only when needed rests after a tick that changed nothing but its time, which the app tells from the world's hash. A clock that runs or a body in flight keeps it ticking with nothing to declare, and an action dispatched between ticks wakes it. The app hashes its world after each tick from the first time `app.settled` is read: about 10 µs for a thousand entities, 0.9 ms for a hundred thousand. A game that ticks in real time pays nothing.

  **Breaking**

  - `Ticks` and `Ticks.more` are removed. Delete the calls: a system with work every tick changes the world, and that keeps the game ticking.
  - A driver with `ticks: "whenNeeded"` no longer runs one more tick after the game is settled, and a new game rests after its first tick when that tick changed nothing. The first read of `app.settled` is false.
  - A system that waits for a moment of game time by comparing it with `Time`, writing nothing while it waits, is never reached in that mode: count down in the world.

- [#323](https://github.com/lucasthevenet/arcadekit/pull/323) [`cdd5655`](https://github.com/lucasthevenet/arcadekit/commit/cdd5655f76b6c043868c20bdd190310ebc1867bf) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Driver.run` takes a `ready` step, `Driver.run(App.make(game), { hz: 60, ready: (app) => ... })`, which runs with the app before its first frame. The run holds the app before `ready` runs, so it closes the app when `ready` fails, and fails with what `ready` failed with. A step tapped onto `App.make` that failed left the app open, with the page's devices and sound, unless the program held it with `Effect.acquireRelease`. `Driver.Ready` is the option's type.

  Nothing breaks. A step tapped onto the effect that makes the app still runs, and still leaves the app open when it fails: give it as `ready` instead.

- [#346](https://github.com/lucasthevenet/arcadekit/pull/346) [`03651e8`](https://github.com/lucasthevenet/arcadekit/commit/03651e83c1c49f504430a675bedf07d48fcf01b3) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Driver.run` takes the game and makes its app itself, with the options of `App.make` beside its own: `Driver.run(Duel, { hz: 60, seed: 1 })`. Nothing can come between the making and the run, so a step that fails after the app is made can no longer leave it open, with the page's devices and sound. Connect something to the app before its first frame with `ready`. When `ready` fails, the run closes the app.

  **Breaking**: `Driver.run` no longer takes an effect that makes an app. Where a game wrote `Driver.run(App.make(game, { seed }), { hz: 60 })`, it writes `Driver.run(game, { seed, hz: 60 })`. A step tapped onto `App.make` goes in `ready`. A program that makes its app itself runs it with `Driver.frames`, and closes it. `Driver.run` still takes an effect that makes a session, or a session connected to its transport.

- [#228](https://github.com/lucasthevenet/arcadekit/pull/228) [`90dff63`](https://github.com/lucasthevenet/arcadekit/commit/90dff63402aee481447dd1a5e87e232fc751e269) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A system that `System.runIf` turns off sees nothing of what happened while it was off: its change queries and `Query.removed` readers skip what changed while it didn't run, as it already heard no event from then. So what a system missed has one rule, and a log of changes no longer grows for a system that stays off. `EcsWorld.skip(reader)` is what an app calls for each system that doesn't run.

  **Breaking**

  - A change query of a system that didn't run no longer holds what changed in the meantime: when the system runs again, it visits only what changed after its last skipped turn. A system that must know the state of the game when it comes back reads it with an ordinary query or a singleton. A change query it has never visited still visits everything that matches.

- [#248](https://github.com/lucasthevenet/arcadekit/pull/248) [`bac33b5`](https://github.com/lucasthevenet/arcadekit/commit/bac33b5a5edd2e743ba20ad2f85665eb7fa67973) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Two parts of an app are modules of their own: `arcadekit/Schedule`, a game's systems with their turns, by when they run, and `arcadekit/Runner`, which runs a game's code to its end and refuses a fiber that outlives it. `App.make` uses both as before. Nothing breaks.

- [#228](https://github.com/lucasthevenet/arcadekit/pull/228) [`728d196`](https://github.com/lucasthevenet/arcadekit/commit/728d1964f8cdafc8e5e13e8dad1c2dfacdf2607f) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Every action and every event has a schema, so each one can be logged, saved, replayed and sent to the other peers of a session, and none fails at run time for lack of one. An action or event with no payload takes only its name: `Action.define("Pass")`, `Event.define("Started")`. `Action.Rejected` has a schema too: its payload is in its JSON form, and its error is the error's `_tag` and `message`. An action with no payload was logged with `undefined`, which a log written as text dropped and could not read back; it is logged with `null`.

  **Breaking**

  - `Action.define<Payload>()("Name")` and `Event.define<Payload>("Name")` are gone. Write `Action.define("Name", schema)` and `Event.define("Name", schema)`, or only the name for no payload.
  - `ActionDef` takes two type parameters, `ActionDef<N, P>`, where it took a third for the validation error. A handler's failures always include `Action.InvalidPayload`.
  - `Action.Rejected`'s `error` is `{ _tag, message }`, not the error itself, and its `payload` is the JSON form. A system that matched on the error's class matches on `error._tag`.
  - `ActionDef.codec` and `EventDef.codec` are never `undefined`.

- [#369](https://github.com/lucasthevenet/arcadekit/pull/369) [`1e72c83`](https://github.com/lucasthevenet/arcadekit/commit/1e72c835ca56c5bbd4f7216b8ce075cbeaed5491) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `State.scoped(Phase, "playing")` is the tag of an entity that lives only while the game is in `"playing"`. When the game leaves `"playing"`, the entities with the tag are despawned, after the exit hooks and before the enter hooks, unless they also have the tag of the state the game enters. A level tagged with `"playing"` and `"paused"` stays through a pause. The tags are components named `"<state>.Scoped.<value>"`, saved, hashed and rewound like any other. A save that holds the tag of a value the state no longer has fails to load with `Save.LoadRefused`, `"unknown component"`.

  Nothing breaks. A game that does not use `State.scoped` keeps the same hash and the same saves.

- [#217](https://github.com/lucasthevenet/arcadekit/pull/217) [`46cb1c5`](https://github.com/lucasthevenet/arcadekit/commit/46cb1c58bbe56eb4b9e8d84004595b018bcd4f6b) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A save and a moment no longer leave a running script behind with no error, and `@arcadekit/three` disposes of the geometries and materials of `Three.instances` and `Three.objects` once no system draws with them.

  **Breaking**

  - `app.capture()` fails with `Save.SaveRefused` while a script is running, and a rewind no longer starts a plugin's scripts again. A rollback session stops with that error on a game whose script is running: do what the script did with systems and states.
  - `app.save()` fails with `Save.SaveRefused` while a script started with `app.spawnScript` or `Script.spawn` is running. Save once it has ended. A plugin's `scripts` still start again after a load.
  - `@arcadekit/three` disposes of the geometry and material given to `Three.instances` or returned by `look`, and of the geometries and materials of what `make` of `Three.objects` built. Drop a `free` that only disposed of them. One that disposes of them too still works.

- [#480](https://github.com/lucasthevenet/arcadekit/pull/480) [`0b8d0a5`](https://github.com/lucasthevenet/arcadekit/commit/0b8d0a5e0fe7a57225ed31cc4fdd241da6ab3ea1) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Small things a game reaches for:

  - An action that takes no payload is issued with none: `app.dispatch(Pause)`, `app.enqueue(Pause)` and `actions.enqueue(Pause)`. `Action.PayloadArgument` is the rest of the arguments they take. An event with no payload is emitted with `emit()`.
  - `ui.subscribe(view, listener)` hands the listener the view's current value at once, then each value published, so a UI needs no `get` beside it.
  - `View.define<A>(name, initial)` gives a view its type where the initial value says less, such as an empty list of ids, and the lint rule `arcadekit/id-casts` names it in place of a cast.
  - `App.make(game, save === undefined ? { seed } : { save })` compiles, and may fail as a load does.
  - `Resource.make(key, value)` takes its default value.
  - `Color.hex(0xff6188)` is the value `Color.Rgb.of` takes for a hex code, and refuses a number that is none.
  - `Assets.match(status, { Absent, Loading, Ready, Failed })` returns what the case of a bundle's status returns.
  - `random.range(2, 5)` and `random.chance(0.1)`, on the world's generator and the frame's.
  - A plugin typed `any`, as one whose import failed is, is refused where the plugins are listed, with a message that says so, in place of one about the order of systems.

  **Breaking**

  - `Resource.make(key, { defaultValue: () => value })` is `Resource.make(key, value)`.
  - `Assets.during(condition, bundle)` is `Assets.during(bundle).pipe(System.runIf(condition))`, as every system's condition is, and with no condition it keeps the bundle loaded. `Assets.during(key, family)` is `Assets.during(family, key)`.
  - A `Sound.Speaker` is told its options by name, as `Sound.Player` is: `play(cue, { volume, rate })` and `music(channel, track, { volume, fade, once })`, where they were positional.
  - A gamepad is read through `Input.Gamepads` alone, as the keyboard and the pointer are through theirs: `yield* Input.Gamepad(i)` is `(yield* Input.Gamepads)(i)`.
  - `ui.subscribe` calls its listener at once: a listener that counted what the game published counts the value it was handed when it subscribed too.

- [#303](https://github.com/lucasthevenet/arcadekit/pull/303) [`bf3e1a9`](https://github.com/lucasthevenet/arcadekit/commit/bf3e1a9b0690a81f37b99c93e546c76f92e28a4e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A page's sound opens in the scope of the program that makes the app, not where `Browser.layerSound` or `Browser.layer` is provided. `Sound.Output` holds `open`, an effect that opens a `Sound.Speaker` in the current scope and lets go of it when that scope closes, and `Sound.plugin` runs it in the scope the app is made in. Provided to `App.make` alone, the page's sound was closed once the app was made, and every cue after it played nothing, with no error; now it is heard for as long as the program that made the app, wherever the layer is provided. The page's audio is shared: the apps made under one provided layer play through one audio context and fetch each file once, and it is closed when the last of them lets go. `Sound.open` opens the output for a program that plays to it itself.

  What breaks:

  - `Sound.OutputShape`, what plays, `{ play, music }`, is `Sound.Speaker`. `Sound.Output` is the interface of what the service holds, `{ open }`.
  - `Effect.provideService(Sound.Output, speaker)` is `Effect.provide(Sound.layer(speaker))`. `Sound.layer(speaker)` is called as before.
  - `yield* Sound.Output` gives `{ open }`, not the speaker: `yield* Sound.open` gives it, in the current scope.
  - `Browser.layerSound` opens nothing when it is built: `Layer.build(Browser.layerSound(files))` no longer fetches the files or listens for the first touch. The page's audio starts when the first app with `Sound.plugin` is made, so a game without it, under `Browser.layer`, no longer fetches the `sounds` files or listens for a touch.
  - The page's audio closes when the last app that plays through it goes: an app made after that opens it again, and waits for a touch again.

- [#282](https://github.com/lucasthevenet/arcadekit/pull/282) [`3683e37`](https://github.com/lucasthevenet/arcadekit/commit/3683e375396bfc4baab888a71491ced3030e69aa) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Commands.spawn` returns a `Spawned` id, whose entity is placed when the system or handler that spawned it finishes. The world's reads take an `Entity`, so reading an entity before it exists doesn't compile, where it threw. `Commands`, a component's value, an event's payload and an action a system enqueues take a `Spawned` id, since each is applied or read once the spawn is placed, and `app.dispatch` gives a handler's `Spawned` back as an `Entity`. `world.placed(id)` gives the entity of an id kept past the code that spawned it, and undefined before its spawn is applied.

  **Breaking**

  - An id from `Commands.spawn` is a `Spawned`, not an `Entity`. Code that keeps one, in a variable a setup fills or in a service, converts it with `world.placed(id)` where it reads the world.
  - `CommandBuffer` of `arcadekit/ecs` is `CommandBuffer<Id>`, whose `spawn` returns `Id`, `Entity` by default.

- [#277](https://github.com/lucasthevenet/arcadekit/pull/277) [`2aafa7a`](https://github.com/lucasthevenet/arcadekit/commit/2aafa7a0e8cde8dd58ae0e8ecd50345abda5b194) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A system's stage is in its type. `System.tick`, `System.frame` and `System.input` refuse a body that uses the other stages, and `App.define` and `Plugin.make` refuse two systems, handlers or plugins that share a name.

  **Breaking**:

  - `System.make` is removed. A system of the tick is `System.tick`, one that draws or plays is `System.frame`, and one that reads the devices is `System.input`.
  - `System.inStage` only moves a system inside the group it was made in: `"preUpdate"` and `"postUpdate"` for a tick, `"preFrame"` and `"postFrame"` for a frame. The input stage is `System.input`.
  - `State.onEnter` and `State.onExit` are `State.onEnter(state, value, name, body)` and `State.onExit(state, value, name, body)`. They are not pipes.
  - Emitting is `yield* Event.emits`, setting a state is `yield* State.sets`, and writing a singleton is `yield* Singleton.writes`. `yield*` on the definition reads. A frame or input system cannot require those.
  - `Sound.Player` and `View.Port` cannot be required by a tick system or an input system. `Input.Devices`, `Frame`, `View.Intake` and `Assets.Store` cannot be required by a tick system.
  - `Action.handler` and a plugin's `setup` take what a tick system takes. `System.runIf` and `System.otherwise` take what the system's stage takes.
  - A tuple of systems, handlers or plugins with one name twice does not compile. A list that is not a tuple is still refused when the app is made.

- [#248](https://github.com/lucasthevenet/arcadekit/pull/248) [`8d502d1`](https://github.com/lucasthevenet/arcadekit/commit/8d502d11518db975a7245f698871dfe2d38f48a6) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A world holds what an app keeps of a game beside its components in stores: the events waiting to be read with each system's place in them, the actions queued for the next tick, and what change queries have yet to visit. A store says what a snapshot holds of it, what the hash covers, what a rewind puts back and what a refused action takes back, so a save is the game's version, its world and the length of its log, and nothing of a game is kept next to its world.

  `app.rewind()` goes back to play on from a moment, as an undo or a search ahead does: the frame and input stages hear every event the game emits from then on, where they missed one whose payload they had heard before the rewind. A session that goes back to run the same ticks again, as rollback does, still has them hear each event once, and an event is now matched only against one heard of the same tick, so one the ticks now emit on another tick is heard.

  Whether the input stage has run since the last tick is saved and goes back with a rewind. A game that was saved, loaded or rewound between the input stage and its tick ran the stage a second time, and applied what it issued twice.

  A refused action that called `Ticks.more()` has not asked for a tick: the app is as settled as it was.

  `app.inspect()` has `stores`: the actions queued for the next tick and the events waiting to be read, as plain data.

  **Breaking**

  - `Save.Save` and `Save.Contents` have no `events` and no `changes`: both are in the world. A migration finds the waiting events under `Event.STORE`, the queued actions under `Action.INTAKE` and what change queries have yet to visit under `Save.VISITS`, in `world.stores` of the contents, where it found the first two in `world.lists`. A save's format is 3, and an earlier release's save is refused.
  - Snapshot format 4 holds stores where it held lists: `SnapshotContents.stores`, each `{ name, data }`, replaces `SnapshotContents.lists`, and `SnapshotStore` replaces `SnapshotList`.
  - `SnapshotProblem` has `"unknown store"` and `"store changed"` in place of `"unknown list"` and `"list changed"`. A waiting event this program doesn't define, or one its schema no longer takes, is `"store changed"`.
  - A world loads what a store held only if it has that store: `new EcsWorld().load(bytes)` refuses the snapshot of an app that held queued actions or waiting events, with `"unknown store"`.
  - `world.hash()` of an app differs from what an earlier release computed whenever an action is queued or an event waits, so a recording made with an earlier release no longer replays.
  - `app.events.emit()` throws while the frame stage or the input stage runs, where it added an event no replay could repeat.
  - A system of the frame or input stage that relied on `app.rewind()` not to hear an event twice reads what it needs from the world, or the game is stepped by a session.
  - `Event.EventsMoment`, `Event.EventMark` and `Event.FRAME_READER` are gone, with the bus's `capture`, `rewind`, `save`, `restore`, `mark`, `rollback`, `commit`, `keepFor`, `beginTick`, `endTick`, `endFrame`, `endInput` and `waiting`, which were the app's to call.
  - The app a session took over, `App.Diverted`, has `rewind`.
  - `world.contents()` has `stores`.

- [#337](https://github.com/lucasthevenet/arcadekit/pull/337) [`809e7eb`](https://github.com/lucasthevenet/arcadekit/commit/809e7eba90b9f64d009166aacb943198b170d444) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The app hands its UI the view bridge. `View.layer(game, mount)` gives an app a UI: when the app is made, `View.plugin` makes the bridge and calls `mount` with it, and a function `mount` returns is called when the app closes. A UI can no longer hold a bridge that no app reads, which took every `send` and queued it forever with no error. A game without `View.plugin`, itself or through one of its plugins, does not compile there.

  **Breaking**

  - `View.makeBridge(game)` is gone, and `View.layer(bridge)` is `View.layer(game, mount)`. A page that wrote `const ui = View.makeBridge(Arcade); mount(root, ui)` and provided `View.layer(ui)` now provides `View.layer(Arcade, (ui) => mount(root, ui))`.
  - A UI is mounted when the app is made, not before. It sees every view at its initial value until the first frame publishes it.
  - The `View.Bridge` reference, the bridge that stood for no UI, is gone. An app with no `View.layer` has no UI, as before.
  - `View.Bridge` no longer has `_publish` and `_take`. A wrapper of a bridge passes on `get`, `subscribe` and `send`.

- [#294](https://github.com/lucasthevenet/arcadekit/pull/294) [`d2153da`](https://github.com/lucasthevenet/arcadekit/commit/d2153da298ac689848532e934492e4961adba155) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - What colour an entity is drawn in is arcadekit's, as where it is drawn is: `arcadekit/Color` gives one component, `Color.Rgb`, of three 32-bit floats and the `space` they are written in, `Color.Srgb`, as a hex code writes a colour, from 0 to 1, or `Color.Linear`, a renderer's own numbers, over 1 for a colour brighter than white. It is white when added bare. `Three.instances(name, { ..., color: Color.Rgb })` draws each entity by the space of its own colour, so entities of one kind can have either. A component of the game's own does not compile as `color`, so neither one of mixed kinds of field nor one of bytes can be passed.

  **Breaking**

  - `Three.instances` no longer takes a colour component of the game's. A game that wrote `const Paint = Component.define("game/Paint", { r: Field.f32, g: Field.f32, b: Field.f32 })` and `color: Paint` spawns `Color.Rgb.of({ r, g, b, space: Color.Srgb })` and writes `color: Color.Rgb`.
  - `colorSpace` is removed. A game that wrote `colorSpace: "srgb-linear"` gives its entities colours whose `space` is `Color.Linear`.
  - A colour in bytes, fields of `Field.u8`, is no longer read. A game that held `{ r: 0xff, g: 0x61, b: 0x88 }` writes `Color.Rgb.of({ r: 0xff / 255, g: 0x61 / 255, b: 0x88 / 255, space: Color.Srgb })`.
  - `Three.ColorComponent` is removed.
  - The two refusals when the system was made, of a component that is no colour and of one whose fields are of mixed kinds, are gone, since neither can be written. A number below 0 or over 1 in `Color.Srgb` still fails the frame, naming the entity, and so does a `space` that is neither.

  Nothing breaks in `arcadekit`: `Color` is new.

- [#348](https://github.com/lucasthevenet/arcadekit/pull/348) [`82f9836`](https://github.com/lucasthevenet/arcadekit/commit/82f98361abfeed034e5cc1ffc58da0a13538d9f0) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The frame stage, the input stage and `app.read` are handed a world with no `set`, events with no `emit`, and no `Commands`, each an object of its own. A cast in those places finds nothing to call, where before it reached a run-time refusal of the frozen world. The tick is handed what it was.

  **Breaking**

  - The `World` service is a `ReadingWorld`, which has no `set`. A system of the tick sets a component with `yield* World.writes(...)`, as before.
  - The `Events` service is the new `Event.ReadingEvents`, which has `handle` and no `emit`. A system of the tick emits with `yield* SomeEvent.emits`. One that held `yield* Events` to call `emit` narrows it with `instanceof Event.EventBus` first.
  - `app.read(World)` is no longer the same object as the `yield* World` of a system.

- [#275](https://github.com/lucasthevenet/arcadekit/pull/275) [`d476a46`](https://github.com/lucasthevenet/arcadekit/commit/d476a46ffaaf793f2b1b6cff1419c7184eb02bf2) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Systems run in the order they are listed, and nothing moves one. `System.before` and `System.after` pulled a system ahead of everything listed between it and the one it named, so it could run before a system it read from, with no error. Now the only order within a stage is the list: a plugin's dependencies' systems, then its own, then the app's.

  **Breaking**: `System.before` and `System.after` are removed, and a system no longer has `before` or `after`. List a system after the ones it reads from. To run a system ahead of one from a plugin you depend on, place it in an earlier stage:

  ```ts
  // Before
  const CallHits = System.make("CallHits", function* () {
    /* … */
  }).pipe(System.before(Casualties));

  // Now
  const CallHits = System.make("CallHits", function* () {
    /* … */
  }).pipe(System.inStage("preUpdate"));
  ```

- [#477](https://github.com/lucasthevenet/arcadekit/pull/477) [`4857bc3`](https://github.com/lucasthevenet/arcadekit/commit/4857bc349ff0f0eb16908f14b0233b655ebbb484) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A query's view reads the one entity a game has with `single()`, which hands out its accessors and its id as `each` would, and throws, naming the query and how many it matched, when that is not one:

  ```ts
  const Players = Query.all(Position).pipe(Query.with(Player));
  const Look = System.tick("game/Look", function* () {
    const [position, player] = (yield* Players).single();
  });
  ```

  A plain function typed for what it writes takes the world, the commands and a singleton of any system that writes those and more: `WritingWorld<"game/Health">` takes `yield* World.writes(Health, Position)`, `Spawning<"game/Spark">` takes `yield* Commands.spawns(Spark, Position)`, and `Singleton.Write<typeof Score>` is what `yield* Score.writes` gives. The systems guide shows one, and the queries guide lists a view's members.

  **Breaking**

  - A tag is not a term of `Query.all`, since it has no data: the loop was handed an empty row in its place. `Query.all(Position, Player)` doesn't compile, and throws for a tag the compiler knows only as a `ComponentDef`. Write `Query.all(Position).pipe(Query.with(Player))`, and drop the tag's argument from the loop, or take it as `Query.maybe(Player)` to be told whether an entity has it.
  - A world or commands that write less no longer pass for ones that write more: a function typed `WritingWorld<"game/Health" | "game/Position">` refuses `yield* World.writes(Health)`, which it took before. Ask the world for every component the function sets.

- [#479](https://github.com/lucasthevenet/arcadekit/pull/479) [`18f7696`](https://github.com/lucasthevenet/arcadekit/commit/18f769617b6b304a19fe5b43820259ff4e7e2b11) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Two games that are the same compare as the same. `world.hash({ time: false })`, on the world `app.read(World)` gives, covers everything `world.hash()` covers but the game's time, so a test of a game paused for 120 ticks compares the game before and after in one call. `world.hash()`, which checkpoints, replays, sessions and the lobby compare, is as it was.

  A save holds whether the game was at rest: an app made from a save of a game that ticks when needed, taken at rest, with `App.make(game, { save })`, or that loads it with `Save.load(app, save)`, is settled, runs no tick before its first action, and goes on tick for tick, and hash for hash, as the game it was saved from. A game's snapshot holds it in the store of the actions queued for the next tick, `Action.INTAKE`, as `rests: true`, beside `queued`. The hash doesn't cover it.

  Nothing breaks. A game loaded from a save of a game at rest runs one tick fewer than it did, the tick that changed nothing but its time.

- [#283](https://github.com/lucasthevenet/arcadekit/pull/283) [`325ff5d`](https://github.com/lucasthevenet/arcadekit/commit/325ff5d06fdf7e648309dbfdcf45af7602257ec4) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The code of the tick, a system of the tick, a state's hook, an action's handler, a plugin's `setup` and a tick system's `runIf` and `otherwise`, requires only the built-in services of the simulation (`World`, `Time`, `Commands`, `Events`, `Actions`, `Random`), and the queries, singletons, states, events and resources it yields. A service of the game's own, from a plugin's `layer` or given to `App.make`, doesn't compile there, since what it keeps is no part of the world and no save, rewind or refused action sees it. Frame and input systems require such services as before.

  **Breaking**

  - A tick system, handler or setup that requires a service of yours doesn't compile, and the error says where each thing goes:
    - the game's state goes in the world, as a component or a singleton;
    - a cache rebuilt from the world, such as a spatial index, goes in a `Field.transient` field of a singleton, which a system rebuilds when it finds it undefined;
    - configuration is a `Resource`;
    - a sound, a log line or a network call is made from `System.frame`, which hears the tick's events.

- [#243](https://github.com/lucasthevenet/arcadekit/pull/243) [`63d43ae`](https://github.com/lucasthevenet/arcadekit/commit/63d43ae40a949da86d11ace1b33d8c667dc246b6) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The world holds the game's time, as the singleton `arcadekit/Time`, so `world.snapshot()`, `world.restore()` and `world.hash()` cover it. A world restored from a snapshot has its time back with nothing else to do, and two peers whose `delta` differs disagree at the next checkpoint. A save no longer carries the time beside the world.

  **Breaking**

  - `Save.Save` and `Save.Contents` have no `tick`, `elapsed` or `delta`. A game reads the time of a loaded save from `app.time`, and a migration that changes it edits the singleton `arcadekit/Time` in `contents.world`.
  - Saves are in format 2. A save written before this release is refused by `Save.decode`.
  - `world.hash()` changes from tick to tick even when nothing else does, and differs from what an earlier release computed for the same game, so a recording made with an earlier release no longer replays.
  - `app.inspect().singletons` and a migration's `contents.world` list `arcadekit/Time`.

- [#456](https://github.com/lucasthevenet/arcadekit/pull/456) [`5786809`](https://github.com/lucasthevenet/arcadekit/commit/5786809ebc734f08460f2efe7a39b16e8ba1c3b5) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/Timer` keeps timers in the world: `Timer.field` for a cooldown that a system counts down with `Timer.tick` and checks with `Timer.ready`, `Timer.lifetime(seconds)` for an entity that `Timer.plugin` despawns when its time is up, and `Timer.every(seconds)`, which runs a system of the tick once per period and keeps the time to its next run in a singleton named after the system. A save holds each, the hash covers each, and a replay fires them on the same ticks. Nothing breaks.

- [#221](https://github.com/lucasthevenet/arcadekit/pull/221) [`fa3eb1a`](https://github.com/lucasthevenet/arcadekit/commit/fa3eb1a8d7ec23c4ddac0e83905174732db6ff6a) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - An app traces itself when the program provides a tracer: it sends what it does as spans at the "Debug" level, one for each tick, holding a span for each action applied in it and for each system's turn, and one for each run of the frame stage and of the input stage, holding their systems'. It makes none, and costs nothing, when no tracer is provided, under `Effect.withTracerEnabled(false)`, or when `Tracer.MinimumTraceLevel` is above "Debug". Tracing doesn't change what the game does.

  **Breaking**: `System.withSpan` is gone: a game that wrapped its systems with it provides a tracer, which traces every system. A program that already provides a tracer now gets a span for every system on every tick, and provides `Tracer.MinimumTraceLevel` as "Info" if it wants only its own.

- [#267](https://github.com/lucasthevenet/arcadekit/pull/267) [`656db0e`](https://github.com/lucasthevenet/arcadekit/commit/656db0e3a97cf1e621a402846c21eec8ff7c4239) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A transport opens in the scope of the program that connects it, not where its layer is provided. The `Transport` service holds `listen`, an effect that opens the channel or the socket in the current scope, closes it with that scope, and gives a `Transport.Listener`, and `Transport.connect(session)` runs it. `Transport.layerBroadcastChannel` and `Transport.layerWebSocket` provided to `Transport.connect` alone closed once the session was joined, and the first tick threw; now the channel lasts as long as the program that drives the session, wherever the layer is provided. `Transport.listen` listens on the transport for a program that sends and receives itself. A transport made with `Transport.text` throws when it is used after `close`, as the two layers do after their scope.

  What breaks:

  - `Transport.connect(session)` requires a `Scope`: run it inside `Effect.scoped`, as a program that drives a session already is.
  - `yield* Transport.Transport` gives `{ listen }`, not the transport: `yield* Transport.listen` gives the transport, in the current scope.
  - `Transport.Shape` is `Transport.Listener`.
  - A layer that listens opens nothing when it is built: `Layer.build(Transport.layerWebSocket(url))` no longer opens the socket.

- [#470](https://github.com/lucasthevenet/arcadekit/pull/470) [`0103057`](https://github.com/lucasthevenet/arcadekit/commit/0103057efa0b3040aa212a47df15168051ab9633) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game under `Driver.run` keeps its turns for an undo, and saves when its rules ask.

  ```ts
  Driver.run(Puzzle, {
    hz: 60,
    ticks: "whenNeeded",
    ready: (app) => Effect.andThen(Timeline.keep(app), Save.autosave(app)),
  });

  // From the game's keys, its UI and its rules:
  const Keys = System.input("game/Keys", function* () {
    (yield* Action.Actions).enqueue(Timeline.Undo, undefined);
  });
  ui.send(Timeline.Redo);
  const LevelEnd = System.tick("game/LevelEnd", function* () {
    (yield* Save.Asked.emits).emit({ slot: "level" });
  });
  ```

  - `Timeline.keep(app)` keeps the game as it was before each turn, a tick or a dispatched action that applied a move from outside. `Timeline.undo(app)` and `Timeline.redo(app)` go back and forward a turn, and so do the actions `Timeline.Undo` and `Timeline.Redo`, which `Timeline.plugin` handles, once the tick that applies one has run.
  - `Save.Asked` is the event a game's rules ask for a save with, and `Save.autosave(app)` takes the save once the tick or the dispatch that asked has run, and writes it to the slot in `Save.Store`. `Timer.every` makes it an interval kept in the world.
  - A rewind puts the log as it was at the moment, to a moment of a future the game gave up as much as to one before: the entries, what became of each, and the ticks' deltas. A rewind forward to such a moment used to leave the log with holes in it.
  - The capturing guide shows an undo stack, and the saving guide an autosave.

  Nothing breaks.

- [#457](https://github.com/lucasthevenet/arcadekit/pull/457) [`322a8ef`](https://github.com/lucasthevenet/arcadekit/commit/322a8efe0bef4c63b98799cbd1eec9bc414ebbe6) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/Vec2` and `arcadekit/Overlap` are new entries. `Vec2.length`, `Vec2.distance`, `Vec2.normalize` and `Vec2.clampLength` work on two numbers and write into a row or an object that is reused. `Overlap.circles`, `Overlap.boxes` and `Overlap.circleBox` test two shapes, and `Overlap.pairs` calls back for every pair of entities of two queries whose `Overlap.Circle` or `Overlap.Box` touch, beside `Transform2d.Position`, and despawns what the callback returns, so an entity it despawns is in no later pair of the call. None of them allocates in its loop. Nothing breaks.

- [#241](https://github.com/lucasthevenet/arcadekit/pull/241) [`c8a0cc1`](https://github.com/lucasthevenet/arcadekit/commit/c8a0cc1ea97571c92279aa4eaaf63acdad2e4141) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Rollback.syncTest(app)` checks that a tick runs the same when a rewind runs it again, as a rollback session does. It takes the app over, as a session does, and each tick it is stepped through is run, rewound and run again from the same moment, with the world's hash compared before the first system and after each one. `tick` throws `Rollback.RewindDiverged`, naming the first system after which the hashes differ, or none when they differed in a handler or a state's hook. This finds what a tick reads that a rewind doesn't put back: state kept in a service, a plugin or a module, or a value from outside the game. The frame and input stages, the action log and the recording see each tick once.

  What took an app over with `app.divert` can now also capture it with the frame and input stages' place kept, and be told when each system of a tick has run.

- [#344](https://github.com/lucasthevenet/arcadekit/pull/344) [`d699901`](https://github.com/lucasthevenet/arcadekit/commit/d699901cff61f605544f47ffdd2282701b255344) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - After `Timeline.rewind` with `{ again: true }`, as a rollback session does, the change queries of the frame and input stages visit only what can differ from what they saw: what they had yet to visit, and the entities that the ticks given up or the ticks run again changed, spawned or despawned. They used to visit every entity after each rewind, so a game drawn from `Query.changed` or `Query.added` redid the whole world on every rollback. A world keeps what its change logs held since each moment it captured, for as long as a moment is held.

  **Breaking**

  - A frame-stage or input-stage change query no longer visits every entity after a rewind with `again`. A system that relied on that to redraw everything visits a query without `Query.changed` or `Query.added` instead. A rewind without `again` still has them visit everything.

- [#382](https://github.com/lucasthevenet/arcadekit/pull/382) [`86e50ad`](https://github.com/lucasthevenet/arcadekit/commit/86e50addcd673e947dad8476ee1a3cf906186b2d) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `view.pointingAt(Rel, target)` narrows a query's view to the entities that point at `target` with the relation `Rel`, and its `each` and `eachChunk` hand them their components as the view's own loops do: `world.view(Children).pointingAt(ChildOf, parent).each((position) => { ... })`. It walks the list the world already keeps of who points at whom, so it looks at no other entity, and visits in the order every loop visits. `Rel` is one of the query's terms, and any other doesn't compile. A change query throws. Over 1,000 children of 100 parents among 100,000 entities, it took 32 µs where `world.sources` with `get` and `set` took 102 µs, as `pnpm --filter arcadekit bench:compare` measured them.

  Nothing breaks.

- [#243](https://github.com/lucasthevenet/arcadekit/pull/243) [`4a8f2cf`](https://github.com/lucasthevenet/arcadekit/commit/4a8f2cf9075af91f48f6518200940021edab2dc0) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - An app's world holds the actions queued for the next tick, with who issued them, and the events the simulation has yet to read, as lists it keeps beside its components. `world.snapshot()`, `world.load()`, `world.restore()` and `world.hash()` cover them, each value in its JSON form, so two peers or a replay whose queued actions or waiting events differ disagree at that checkpoint, not later when it reaches the world, and a restored world is the whole game again. After `world.restore()`, every system reads the waiting events as if it had read none of them, as in a loaded game. Where each reader is, how far a system has read and what change queries haven't visited, stays out of the world, so a plugin that only watches doesn't change the hash. `app.capture()` holds the queued actions and the events by reference, as before, and encodes none of them.

  `verifyFrames` checks the hash without the queued actions, since issuing them is what the input and frame stages are for.

  **Breaking**

  - `world.hash()` of an app differs from what an earlier release computed whenever an action is queued or an event waits, so a recording made with an earlier release no longer replays. A world made with `new EcsWorld()` hashes as before.
  - Snapshots are written in format 4, which holds the world's lists and puts the singletons before the tables. Formats 1 to 3 are still read; an earlier release can't read format 4.
  - `Save.Save` and `Save.Contents` have no `queued`, and their `events` hold only `{ name, read }`: the actions and the events are in the world, under `world.lists` of the contents, `arcadekit/queued` for the actions and each event's name for its events. A migration that changed `queued` or the payloads of `events` changes `world.lists` instead.
  - `Save.LoadRefused` no longer has the problems `"unknown event"` and `"event changed"`: a waiting event this program doesn't define is a snapshot's `"unknown list"`, and one its schema no longer takes is `"list changed"`. `SnapshotProblem` has both.

- [#276](https://github.com/lucasthevenet/arcadekit/pull/276) [`82b7d03`](https://github.com/lucasthevenet/arcadekit/commit/82b7d03ee72416c7fd9ca90ec1bc6184f4724cf4) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A system says what it spawns and what it sets where it asks for the thing that does it, so the compiler knows, and the order of a list of systems is checked for those too. A system that watches a component with `Query.added` or `Query.changed`, listed ahead of a system that spawns it, adds it or sets it with `world.set`, reacted a tick late with no error: a spawn and a `world.set` were plain calls that nothing in a system's type recorded. Now that list doesn't compile, as one with a watcher ahead of a query that writes already didn't.

  - `yield* Commands.spawns(Bullet, Position)` gives commands that spawn and add those components. Another component doesn't compile, and the error says where to name it. `yield* Commands` gives commands that despawn and remove.
  - `yield* World.writes(Health)` gives a world that sets that component. `yield* World` gives one that reads.
  - The world a system, a handler or a plugin's `setup` is handed reads an entity and a singleton, and no longer has `spawn`, `despawn`, `add`, `remove`, `view`, `random`, or what an app does with its world, such as `restore` and `freeze`. The set of entities changes through `Commands` alone. `app.world` is the whole world, as before.

  `Query.removed` isn't checked: a despawn doesn't say which components its entity had. Its doc comment says so.

  **Breaking**:

  ```ts
  // Before
  const Shoot = System.make("Shoot", function* () {
    const commands = yield* Commands;
    commands.spawn(Bullet, Position.of({ x: 0, y: 0 }));
  });
  const strike = Action.handler(Strike, function* ({ target }) {
    const world = yield* World;
    world.set(target, Health, { hp: 3 });
  });

  // Now
  const Shoot = System.make("Shoot", function* () {
    const commands = yield* Commands.spawns(Bullet, Position);
    commands.spawn(Bullet, Position.of({ x: 0, y: 0 }));
  });
  const strike = Action.handler(Strike, function* ({ target }) {
    const world = yield* World.writes(Health);
    world.set(target, Health, { hp: 3 });
  });
  ```

  - A query is asked for with `yield*`, and no longer taken from a yielded world with `world.view(query)`.
  - `Commands` gives a `Spawning`, and no longer the `CommandBuffer` with its `apply`: commands are applied when the system finishes.
  - `ComponentValue` has a second type parameter, the component's name, and `Query.Query`'s second is now what it watches, as `Query.Watches` and `Query.WatchesAdded`.
  - A list with a system that watches ahead of one that spawns, adds or sets what it watches no longer compiles.

- [#478](https://github.com/lucasthevenet/arcadekit/pull/478) [`7bfc4b6`](https://github.com/lucasthevenet/arcadekit/commit/7bfc4b61a928e52884212a8f23fcad1fa48cd623) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A hook can tell where the game came from: `State.onTransition(Phase, { from: "menu", to: "playing" }, "StartRun", body)` runs on entering `"playing"` from the menu, and not on a resume from `"paused"`. `from` is one value or a list. A system names a run's scope once: `Commands.spawns(...).pipe(State.scoping(Phase, "playing", "paused"))` gives every entity those commands spawn the tags of both values, so no spawn leaves them off. The states guide shows a run that is started, paused, resumed and restarted.

  Nothing breaks.

### Patch Changes

- [#321](https://github.com/lucasthevenet/arcadekit/pull/321) [`e26b295`](https://github.com/lucasthevenet/arcadekit/commit/e26b295c0e07be647a662bb7e882f842f5fc3122) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A frame that fails plays nothing it asked `Sound.Player` for, and holds nothing against the next frame. Before, what it said of a channel stood until a frame ended well, so a system that set another track on that channel in the next frame was refused as if two systems had spoken in one frame, and the cues it asked for played a frame late. `Sound.plugin` now adds `arcadekit/Sound.Begin` in `"preFrame"`, which starts each frame with nothing requested.

  Nothing a game writes changes. `app.frameOrder` lists `arcadekit/Sound.Begin` before the frame's other systems.

- [#487](https://github.com/lucasthevenet/arcadekit/pull/487) [`923908d`](https://github.com/lucasthevenet/arcadekit/commit/923908d56563732b3235e5692f2a592d5eb7666f) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A save, a capture or a snapshot that a `Field.ref` codec refuses says what the codec's `encode` threw, after the field's name: `"gr/Small.tiles" holds a value its codec refuses: a map of 3 by 3 is in a field of 2 by 2`. A `Field.schema` field says where its value fails the schema. Both used to say only that the codec "did not turn into plain data". Nothing breaks: only the text of the message of `Save.Refused` and of `SnapshotError` changes.

- [#336](https://github.com/lucasthevenet/arcadekit/pull/336) [`a608613`](https://github.com/lucasthevenet/arcadekit/commit/a608613dd8b86e2df9106c93914e8ce171d01ea0) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `World.rollback()` with no transaction in progress throws before it changes anything. It used to put `world.random` back to where it was at the last `begin` before it threw, so the world's hash changed on a call that was refused. Nothing breaks.

- [#522](https://github.com/lucasthevenet/arcadekit/pull/522) [`97b37c3`](https://github.com/lucasthevenet/arcadekit/commit/97b37c314d499c3e586f3badce182ddd76ccf3c9) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `yield*` on a state hands out the same reader each time in a world, where it made a new one on every yield. A condition of `State.is` costs about half what it did, and a system that it keeps from running now costs less than one that runs and does nothing. Ten systems that `System.runIf` skips tick in about half the time they did, and ten whose condition holds in about a quarter less.

  Nothing breaks. The reader reads the world as it is when it is read, as before, and a reader from one world never reads another.

- [#319](https://github.com/lucasthevenet/arcadekit/pull/319) [`5d8493a`](https://github.com/lucasthevenet/arcadekit/commit/5d8493af77c8c675e93404f99758a58782ef9982) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The doc comments of `App.Options.version` and `Save.Save.version` say what a load checks whatever the version: each component's storage and its fields' names, order and kinds, refused with `"component changed"`. They say what it can't check, a field whose values mean something else with the same shape, which loads with no error unless the version is incremented and a migration converts the values. Nothing breaks.

- [#339](https://github.com/lucasthevenet/arcadekit/pull/339) [`51d3e8a`](https://github.com/lucasthevenet/arcadekit/commit/51d3e8a79ddc08374295f3e1a6fdd53e25156c44) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `World.view` keeps one view per description, by the components it names and where, and no longer one per description object. A system that writes its query as a new object literal on every call gets the same view each time, where before the world made and kept a new one per call.

  Nothing breaks. A game that kept its description in a constant sees no difference.

- [#258](https://github.com/lucasthevenet/arcadekit/pull/258) [`bf1daec`](https://github.com/lucasthevenet/arcadekit/commit/bf1daec9691bdb1dc9efa404155806a754e543ee) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - What `App.make` did itself and was another module's is that module's: taking a save and filling a world from one are `Save`'s, running a plugin's setup and saying whether the game has come to rest are the loop's, and a game's handlers by name are the inbox's. Nothing breaks.

- [#525](https://github.com/lucasthevenet/arcadekit/pull/525) [`ba281a6`](https://github.com/lucasthevenet/arcadekit/commit/ba281a6f7f2d8a094f13f4827b6c88450a271728) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Drawing between two ticks takes less time a frame. Each blend of `Transform2d.smooth`, `Transform3d.smooth` and `Color.smooth` looked over every row it was handed for the largest entity index before its loop, to make room for it, and now makes room when its loop comes to an index past the end. A kind of `@arcadekit/three` drawn with `smooth: true` and a position alone draws as fast as it did before `Transform2d.smooth` came, where it had been 6% to 10% slower, and one with a rotation, a scale or a colour 6% to 11% faster. Nothing breaks.

- [#156](https://github.com/lucasthevenet/arcadekit/pull/156) [`dc1e4bc`](https://github.com/lucasthevenet/arcadekit/commit/dc1e4bc62b6f82d2c136ec92b2129c388cb5a834) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The doc comments of every export are rewritten in plain, present-tense English, so the Reference pages and editor tooltips read the way the rest of the site does, and they no longer recount how the storage core's entity ids used to be laid out. The READMEs drop their link to the site's "Not done yet" page, which is gone: the site describes arcadekit as it is, and what is not built is in the repository's roadmap. Nothing breaks.

- [#317](https://github.com/lucasthevenet/arcadekit/pull/317) [`5f8699c`](https://github.com/lucasthevenet/arcadekit/commit/5f8699c2afc6fbf391840172fc35a35f1785738a) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The doc comments of every export are edited to one thought per sentence, with caveats under **Gotchas**, and corrected where they were wrong about the code. Among the corrections: a message for a tick that already ran makes a session go back rather than being dropped, `yield*` on a state returns a `StateView`, a tick never runs the input stage itself, and requiring `Sound.Player` in the simulation doesn't compile rather than throwing. `System.spanLevel` is now `@internal` and leaves the reference. Nothing breaks.

- [#384](https://github.com/lucasthevenet/arcadekit/pull/384) [`96a5f7e`](https://github.com/lucasthevenet/arcadekit/commit/96a5f7eed461a30bb8e1b0950bc932471eb48d35) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The types that public signatures name are documented, and on the reference, where they were exported and marked `@internal`: `App.Systems`, `App.Handlers`, `App.Plugins`, `App.TickError`, `App.AllHandlers` and `App.External`; `Plugin.Clashes`; and `System.TickGated`, `System.TickBody`, `System.FrameOk`, `System.FrameBody`, `System.TickEffect`, `System.LayerGated`, `System.Listing` and `System.Ordered`. `@arcadekit/three/Three` adds `Three.Entries`, the assets of a bundle a look is built `from`, and `Three.Needs`, what its drawing systems require, which `Three.instances` and `Three.objects` named and a game could not.

  Nothing breaks: no export is removed or changed.

- [#484](https://github.com/lucasthevenet/arcadekit/pull/484) [`943ada6`](https://github.com/lucasthevenet/arcadekit/commit/943ada68fde271010fa061fe0becd12eaa863a4f) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit` no longer lists `@cloudflare/workers-types` as an optional peer dependency, which none of its code uses. Nothing breaks: a Worker that hosts the relay depends on `@cloudflare/workers-types` itself, as `examples/relay-cloudflare` does.

- [#161](https://github.com/lucasthevenet/arcadekit/pull/161) [`f76410d`](https://github.com/lucasthevenet/arcadekit/commit/f76410dd5c56b302a5cd55d1b03c394f69cc1e00) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The build writes each source file to a file of its own in `dist/`, `dist/ecs/world.js` for `src/ecs/world.ts`, in place of chunks shared between entries. An entry now loads only the modules it reaches, and imports only the packages they import.

  Nothing breaks: the entries, and what each one gives, are the same.

- [#257](https://github.com/lucasthevenet/arcadekit/pull/257) [`46abea7`](https://github.com/lucasthevenet/arcadekit/commit/46abea7ad1b2a30d47d427846cbf560e53b7022a) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A snapshot's format is read in one place and written in one. `world.snapshot()` and `writeSnapshot` wrote it separately, and `world.load()` and `readSnapshot` read it separately, so a change to the format was made four times. A snapshot's bytes are what they were, and every format a world read, it still reads.

  Nothing breaks. Two messages changed: when `writeSnapshot` is given a field or a store that holds what is not plain data, it now says what the value is, as `world.snapshot()` does.

- [#154](https://github.com/lucasthevenet/arcadekit/pull/154) [`7a2bfe8`](https://github.com/lucasthevenet/arcadekit/commit/7a2bfe881e8d6cc7c762ec594be7b1f6e71a942e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The READMEs are a description and links. What they explained is on [arcadekit.dev](https://arcadekit.dev), in the guides and the concepts, with what is not built yet on a page of its own, and the doc comments of the exports say what the READMEs said of them. Nothing breaks.

- [#383](https://github.com/lucasthevenet/arcadekit/pull/383) [`cdbe551`](https://github.com/lucasthevenet/arcadekit/commit/cdbe5518081359cf395e191147640255cda634a0) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A spawn finds its table by a step per component id, where it built a key of text, and keeps its components in order of id as they come, where it sorted them; a despawn skips a relation nobody points at the entity with. Spawning and despawning 1,000 entities takes 38% less time, with a relation or without, and a cascading despawn 9% less. Nothing breaks: entity ids, the order tables are made in, the hash and the snapshot are what they were.

- [#245](https://github.com/lucasthevenet/arcadekit/pull/245) [`3fc2610`](https://github.com/lucasthevenet/arcadekit/commit/3fc2610f10ab1039cacd973977d623d22cd996bf) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - An app no longer keeps a flag of its own for whether the game has started: it has started once its action log holds anything. Nothing breaks.

- [#343](https://github.com/lucasthevenet/arcadekit/pull/343) [`878ddb4`](https://github.com/lucasthevenet/arcadekit/commit/878ddb417be6660b732ce44e1e6159888091557c) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The reference of `arcadekit/net/Session` and of `session.confirmed` says what the frame stage does in a session that runs ahead: it hears each event once however often a rewind runs its tick, it has already drawn and played what a prediction did, and its change queries visit everything after each rewind. A frame system that must show only final ticks checks `session.confirmed`. Nothing breaks.

- [#513](https://github.com/lucasthevenet/arcadekit/pull/513) [`347178f`](https://github.com/lucasthevenet/arcadekit/commit/347178fef9351b018394d423459b115923537f7e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `System.Misordered`, `System.Listing`, `System.Duplicated` and `System.Ordered` are declared in `System` itself, so the reference links each to `src/System.ts`. The built package no longer has `dist/system/order.js` and `dist/system/order.d.ts`, which no entry exported. Nothing breaks.

- [#481](https://github.com/lucasthevenet/arcadekit/pull/481) [`fb20c3b`](https://github.com/lucasthevenet/arcadekit/commit/fb20c3be3adbc28fa487697ef4be19d22b9848b8) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The doc comment of `Action.define` says that an action with no payload is issued with none, where it said `undefined`. The doc comment of `View.Bridge`'s `send` says that an action with no payload is sent with none, `ui.send(Start)`, and the module comment of `Browser` imports it as a game does, `import { Browser } from "arcadekit/browser"`. The doc comment of the world's `hash` names the singletons arcadekit keeps, which it covers, and what it leaves out. Nothing breaks.

- [#266](https://github.com/lucasthevenet/arcadekit/pull/266) [`db8014a`](https://github.com/lucasthevenet/arcadekit/commit/db8014a316aadd221e4f9ebddf030b69dbd4f80d) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Drift.Drifted`'s doc comment says what the world's hash leaves out as it is now: how far a system has read, and a system's own variables. It still gave an event only one peer has waiting, which the hash has covered since queued actions and waiting events went into the world. Nothing breaks.
