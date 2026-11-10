# arcadekit

Versions up to 0.2.3 were published as the nine `@arcadekit/*` packages (core, input, content, save, audio, render-three, runtime, net and foldkit); their entries are merged here.

## 0.4.0

### Minor Changes

- [#69](https://github.com/lucasthevenet/arcadekit/pull/69) [`1758082`](https://github.com/lucasthevenet/arcadekit/commit/1758082f621e4a7145b5e90c6844dd94fedaa5e1) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The kit owns the Co-op client: one player's side of a co-op game, from the lobby to the run. It was the survivors demo's own code, which every game with co-op had to copy. A game now supplies its genre half, and its app keeps the lobby screens (ADR-0019).

  ```ts
  import { browserCoopRooms, makeCoopClient } from "arcadekit/net/browser";

  const play = Effect.gen(function* () {
    const coop = yield* makeCoopClient(myCoopGame, {
      rooms: browserCoopRooms({ url: "wss://game.example.com", iceServers }),
    });
    yield* coop.listen((event) => {
      // lobby, started, run, waiting, failed
    });
    yield* coop.host("knight");
    return yield* coop.attach(element);
  }).pipe(Effect.scoped);
  ```

  **`arcadekit/net`** (DOM-free) gains a Co-op game's lockstep parts:

  - `CoopRules<G>` and the `CoopTypes` bag `G` a game declares once (`Config`, `State`, `Event`, `PlayerInput`, `Answer`, `LocalEvent`, `Content`). The rules hold the `simulation`, whose step input is `PlayerInputs<PlayerInput>`, with `codec`, `hash`, `picks`, `config`, the optional `maxPlayers` and `lockstep: { inputDelay, hashEvery }` (defaults `DEFAULT_ROOM_SIZE`, 4 and 60), and what the local player's seat needs: `localInput`, `settled`, `choosing`, `localEvent` and `runEnded`. The client combines the players' inputs with `combinePlayerInputs`, so the rules have no `combine`.

  The lobby's messages and state, and the content hash peers compare at the start, are behind the client, not exports. Content must be JSON data, and its hash is sensitive to key order.

  **`arcadekit/net/browser`** gains the client:

  - `makeCoopClient(game, { rooms, ticker?, frames? })`, a scoped Effect, and its `CoopClient`: `host(pick)`, `join(code, pick)`, `choose(pick)`, `start`, `answer(answer)`, `setPaused(paused)`, `leave`, `attach(element)`, `listen(onEvent)` and `debug()`. The commands return at once, except `leave`, which returns once the seat has closed; a new seat says nothing until every seat before it has. `attach` and `listen` have the shapes of `arcadekit/foldkit`'s `AttachableEngine`, so `engineEntry` takes the client as it is. `attach` fails with `AttachError`, `GameCrashed` or the game's `LoadError`, and a failed attach leaves the seat.
  - `CoopGame<G, LoadError>`: the rules plus `content`, an Effect run once per host or join, and `presentation`, an Effect run once per attach that gives a `CoopPresentation` (`createInput`, `createView`). The view gets a live `LocalPlayer` (`slot`, `names`) and reads it when it renders.
  - `CoopEvent`: `lobby` (role, code, self, `LobbyPlayer`s, `maxPlayers`, `canStart`), `started` (slot, names), `run` (what the game's `localEvent` makes of a run's event), `waiting` (who stepping waits on, who is choosing) and `failed`, with the kit's English `message` and a `CoopFailure` reason an app can re-word: `content`, `room`, `leftOut`, `unknownPick`, `tooManyPlayers`, `hostLost`, `desync`, `contentMismatch`, `removed`, `badInput` or `bug`. Player names ("Host", "Guest 2") are the kit's too.
  - `CoopRooms` and `browserCoopRooms({ url, iceServers })`. The kit reads no environment: the app passes the signalling worker's URL and its STUN servers.
  - `CoopClientOptions` and `CoopDebug` are the types of the client's options and of `debug()`. Unless given a `ticker`, the client times each run in a dedicated Web Worker, which a hidden tab doesn't throttle.

  **New entry `arcadekit/net/testing`**, for tests only: `fakeCoopRooms()` (the signalling worker and WebRTC in memory, with `drop(peer)`, `closeHost()`, its `code` and a `log`; `FAKE_JOIN_CODE` is the code), `manualTicker()` (a ticker the test drives) and `testCoopGame(options?)`, a small Co-op game with lobby picks, an offer to answer, a pause and an end. Its parts are exported too, so a test can vary the game: `testCoopRules`, `testSimulation`, `testPresentation`, `testContent`, `hashTestState` and the `Test*` types. It needs only `effect`. Frames come from `manualFrames()` in `arcadekit/runtime/testing`.

  Behaviour is ADR-0012's, as the demo's client had it: no late join, the drop rule, a host star. Three things are new for a game that used the demo's client as its model:

  - At the start the host replaces an empty or unknown lobby pick with the game's first, and a guest that receives a pick its own content lacks fails with `unknownPick` instead of starting.
  - The game's `maxPlayers` bounds a run, not the room's size. The host starts the first `maxPlayers` players in lobby order, so a guest that links as the host starts can be left out (`leftOut`), and a guest refuses a start with more players than its own game takes (`tooManyPlayers`: only a host on another build sends one).
  - The lobby's messages on the wire are `pick`, `lobby` (players with `pick`) and `start` (players, picks). Peers on different builds can't share a lobby.

  Per-step and per-frame code is plain, with no Effect: the game's `settled`, `choosing` and the function `localInput` returns run between steps and must not allocate. The package has eighteen entries. `net/testing` is in the `net` group, so it adds no arrow between entries.

  Nothing breaks for the existing entries: every change is a new export or a new entry, and no export was removed or changed.

- [#68](https://github.com/lucasthevenet/arcadekit/pull/68) [`5e672c3`](https://github.com/lucasthevenet/arcadekit/commit/5e672c3f60c754f7c0c12562beb9c25ff32c1fc6) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The kit owns the step input of a game with several players, and how lockstep fills it. Each game used to carry its own copy of the same type and two helpers.

  - `arcadekit/runtime` exports `PlayerInputs<PlayerInput>`: `players[slot]` is one player's input for the step, or null when that player has none, and `leaving` lists the slots that leave the run at this step, in ascending order. A slot is a player's place in the run's player order, host first in lockstep. A game uses it as its `GameSimulation`'s `Input`.
  - `arcadekit/runtime` exports `soloInput(source)`: a `StepInput<PlayerInputs<PlayerInput>>` from one player's `StepInput<PlayerInput>`, at slot 0, with nobody leaving. `endStep` and `endFrame` reach the source.
  - `arcadekit/net` exports `combinePlayerInputs(players)`: a lockstep session's `combine` for such a game. `players` is the run's player order, host first; it returns a function from a `ConfirmedStep<PlayerInput>` to `PlayerInputs<PlayerInput>`.

  All three are plain code, with no Effect. `soloInput` and `combinePlayerInputs` refill one object, so a step allocates nothing.

  Nothing breaks for the existing entries: these are new exports, no export changed, and it adds no arrow between entries (`net` already imports `runtime`).

- [#66](https://github.com/lucasthevenet/arcadekit/pull/66) [`93c0d67`](https://github.com/lucasthevenet/arcadekit/commit/93c0d67d44d4914c9294663b299522f5be4dc7e9) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - New entry `arcadekit/net/worker`: the signalling worker, for Cloudflare. It was the survivors demo's own code, which every game with co-op had to copy. An app's Worker is now a few lines:

  ```ts
  import { signallingRoom, signallingWorker } from "arcadekit/net/worker";

  export class SignallingRoom extends signallingRoom({ roomSize: 4 }) {}

  export default signallingWorker({ rooms: "ROOMS", assets: "ASSETS" });
  ```

  - `signallingRoom(options?)` returns the Durable Object class of one join code's room, for the app to extend and export under the name its binding declares. `signallingWorker({ rooms, assets })` returns the Worker's `fetch` handler, given the names of the app's two bindings. The app still declares its Worker, bindings and routes itself (the demo's `alchemy.run.ts`).
  - The room size is a setting of the worker: `roomSize`, a whole number from 2 to `MAX_ROOM_SIZE` (16), and `DEFAULT_ROOM_SIZE` (4) if left out. `signallingRoom` throws a `RangeError` for any other size when the Worker's module loads; it never changes it to another one. A lockstep run's own limit on the wire is separate and unchanged.
  - The worker behaves as the demo's did (ADR-0012). Its Effect service key is `arcadekit/net/worker/RoomConnections`.
  - `@cloudflare/workers-types` (^5) is a new optional peer, for this entry's types. The entry imports `cloudflare:workers`, so it runs only on Cloudflare; typecheck a Worker that uses it with Workers types, no DOM `lib`, and `skipLibCheck` (Effect's own type files name DOM types).
  - It adds no arrow between entries: the worker is in the `net` group, which lint checks as one entry, and imports only `net/signalling`'s protocol. Within the group, only the worker's own typecheck (Workers types, no DOM) keeps it apart from `arcadekit/net/browser`.

  **Breaking:**

  - `arcadekit/net/signalling` exports `DEFAULT_ROOM_SIZE` (4) and `MAX_ROOM_SIZE` (16) in place of `MAX_PLAYERS` (4). Use `DEFAULT_ROOM_SIZE` where you used `MAX_PLAYERS`, unless your worker sets another room size.
  - `parseServerMessage` accepts a `welcome` that lists up to `MAX_ROOM_SIZE - 1` peers (it was 3). The bound follows the renamed constant: the worker's `welcome` still lists at most the host, at any room size.

  No other entry changes.

## 0.3.0

### Minor Changes

- [#64](https://github.com/lucasthevenet/arcadekit/pull/64) [`f426e1a`](https://github.com/lucasthevenet/arcadekit/commit/f426e1ae6c295cb71df49953fa168b6e88deba32) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The kit is one package. `arcadekit` replaces the nine `@arcadekit/*` packages (`core`, `input`, `content`, `save`, `audio`, `render-three`, `runtime`, `net`, `foldkit`), which get no further release (ADR-0018).

  **Breaking:**

  - Replace the `@arcadekit/*` dependencies with `arcadekit`, and change each import from `@arcadekit/<entry>` to `arcadekit/<entry>`: `@arcadekit/runtime/browser` is `arcadekit/runtime/browser`. The sixteen entries and what each exports are unchanged. The package has no root export.
  - `effect` is the one required peer dependency. `three`, `@types/three`, `foldkit` and `@effect/platform-browser` are optional peers: install the ones the entries you import need.
  - The Effect service keys follow the name: `@arcadekit/audio/Audio` is `arcadekit/audio/Audio`, and `@arcadekit/net/PeerConnector` is `arcadekit/net/PeerConnector`.

## 0.2.3

### Patch Changes

- [#62](https://github.com/lucasthevenet/arcadekit/pull/62) [`ec25311`](https://github.com/lucasthevenet/arcadekit/commit/ec25311c214f6a9fd367a73565b62d10b30217bb) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Stage.dispose()` releases its WebGL context (`forceContextLoss`). It used to leave the context alive until the canvas was collected, so a game that makes stages one after another (a view per attach) piled them up. Chrome keeps 16 a page and then kills the oldest, which can be a live stage's, and a page that keeps losing them can be refused new ones ("Error creating WebGL context").

## 0.2.2

### Patch Changes

- [#60](https://github.com/lucasthevenet/arcadekit/pull/60) [`5558bd9`](https://github.com/lucasthevenet/arcadekit/commit/5558bd93cfc12f3e4ebbb76d33e224b6b6b6035e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `InputController` drags and swipes again on iPhone Safari. It has no pointer lock and leaves `document.pointerLockElement` undefined, which the check for a locked pointer read as locked, so every press was ignored.

## 0.2.1

### Patch Changes

- [#58](https://github.com/lucasthevenet/arcadekit/pull/58) [`9e2651a`](https://github.com/lucasthevenet/arcadekit/commit/9e2651a50ea9de9c41e0f94c96adcc826430d082) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `InputController` ignores pointer presses while the document has a pointer lock, such as a game's mouse look on the same surface. It used to call `setPointerCapture`, which throws `InvalidStateError` while the pointer is locked, so every click during mouse look threw from its listener. A locked pointer stays put on screen, so it can't drag or swipe anyway; drags and swipes work again once the lock is released.

## 0.2.0

### Minor Changes

- [#52](https://github.com/lucasthevenet/arcadekit/pull/52) [`faebbf6`](https://github.com/lucasthevenet/arcadekit/commit/faebbf67e4237cce060a6727dae620400a8657f2) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The mixer keeps its decoded files in Effect's `Cache`, so the library no longer runs an Effect of its own to share a decode. `load` behaves as before: a file is decoded once, even when two loads of it overlap, and a file that failed is tried again by the next load.

  Breaking:

  - `makeAudioMixer(options)` returns `Effect<AudioMixer>` (was `AudioMixer`). Yield it inside your program, or run it where your program starts (`Effect.runSync(makeAudioMixer(options))` in a test).
  - `makeBrowserAudio` in `@arcadekit/audio/browser` is `Effect<AudioMixer, never, Scope>` (was a function returning `{ audio, dispose }`). Closing its scope does what `dispose` did: it removes its listeners, stops its sounds and closes the AudioContext. `BrowserAudioLayer` is unchanged.

- [#51](https://github.com/lucasthevenet/arcadekit/pull/51) [`f46fda2`](https://github.com/lucasthevenet/arcadekit/commit/f46fda2ce4865cfd3c6d53b872d4e31e6d190801) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `GameEngine.attach` now fails with a typed `AttachError` (exported from `@arcadekit/runtime/browser`, with the thrown `cause`) when `createView` or `createInput` throws, such as Three.js finding no WebGL, instead of dying. Its new type, `(element) => Effect<never, AttachError | GameCrashed>`, is in the frame loop entry. Nothing is left attached: a view made before `createInput` threw is disposed, and a throwing `dispose` still disposes the view and lets the engine attach again. `makeEngineLoader` now frees the assets of a load whose `game` throws.

  `engineEntry` hands an attach failure to `onError`, so the app gets a Message instead of a blank viewport. `EngineEntryConfig` takes a sixth type parameter, `A`, for what `attach` fails with, and `onError` receives `E | A`.

  `AudioSystem.load` now decodes a file once when two loads of it overlap.

  Breaking:

  - `engineEntry` with a `GameEngine` (or `engineOf(loader)`) now requires `onError`, which also receives `AttachError`. An entry for a plain `GameEngine` that had no `onError` must add one.
  - `EngineEntryConfig<Model, Message, Event, R, E>` is now `EngineEntryConfig<Model, Message, Event, R, E, A>`; `engine` is `Effect<AttachableEngine<Event, A>, E, R>`.

- [#52](https://github.com/lucasthevenet/arcadekit/pull/52) [`faebbf6`](https://github.com/lucasthevenet/arcadekit/commit/faebbf67e4237cce060a6727dae620400a8657f2) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The browser frame loop is an Effect now. `GameEngine.attach(element)` makes the view and the input source, then runs the frame loop itself for as long as it stays attached: each frame waits for the next animation frame, steps the run, then draws, all in one go. A frame whose step, render or event listener throws is the last one: the run ends, the loop asks for no more frames, the view and input source are disposed, and `attach` fails with the new `GameCrashed` (exported from `@arcadekit/runtime/browser`, with the thrown `cause`). Before, the loop kept running after a throw and nothing on the Effect side was told. The first frame no longer steps by a negative time when `requestAnimationFrame`'s time is before attach.

  `engineEntry` runs `attach` instead of waiting forever after it, so a crash reaches `onError` as a Message, sent once, like a failed attach.

  Breaking:

  - `GameEngine.attach` is `(element) => Effect<never, AttachError | GameCrashed>` (was `Effect<void, never, Scope>`). It runs until interrupted instead of returning once attached, and it needs no `Scope`. Interrupt it to detach. It fails with `AttachError` when `createView` or `createInput` throws, and with `GameCrashed` when a frame throws. It never succeeds, so run it last: start the run, then `return yield* engine.attach(element)`. Its failures reach only what waits on it: a forked `attach` that nothing joins (`Effect.forkScoped(engine.attach(element))` alone) loses them silently, so join its fiber (`Fiber.join`) or race the rest of the program against it (`Effect.raceFirst(rest, engine.attach(element))`).
  - A crash ends the run, as `stop` does: attached again, the engine draws no run until the app starts a new one. Before, the run stayed live after a throw, and the next frame ran the step that threw again.
  - `AttachableEngine<Event, E>.attach` is `(element) => Effect<never, E>` (was `Effect<void, E, Scope>`): it runs until interrupted, and fails with `E` if it can't attach or stops on its own. An engine that draws on its own timer ends its `attach` with `Effect.never`, scoped.
  - `onError` in `engineEntry` for a `GameEngine` (or `engineOf(loader)`) also receives `GameCrashed`.
  - `GameDriver` is removed from `@arcadekit/runtime/browser`. Use `makeGameEngine` to step and draw in the browser, or `GameLoop` to step without drawing.

- [#55](https://github.com/lucasthevenet/arcadekit/pull/55) [`f7a8e30`](https://github.com/lucasthevenet/arcadekit/commit/f7a8e3080caba32b1c7f0662d752830881db3501) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The browser's signalling client is an Effect program. `hostRoom(options)` and `joinRoom(options, code)` are scoped Effects that succeed once the signalling server welcomes the peer, so the room's `code` and `self` are always known. The scope owns the socket until the start, and every peer connection and link after it: closing it is leaving, and a room that fails has already closed what it opened. `room.events` is a `Stream` of what happens after the welcome, which ends with `started` and fails with the room's `RoomError`; events wait until they are read, and leaving interrupts a reader that is still reading. `browserRoomLayer(rtc)` provides what a room needs in a browser: the new `PeerConnector` service (`rtcPeerConnector`, over WebRTC) and `Socket.WebSocketConstructor` from `effect/socket`. Tests provide fakes of both and drive the timeouts with a `TestClock`. Also new: `PeerConnectorApi`, `PeerLinkOptions`, `PeerConnectionLike`, `IceCandidateLike`, `DataChannelLike` and `RoomServices` (`PeerConnector | Socket.WebSocketConstructor`).

  Fixes:

  - A room whose socket opens but whose welcome never comes fails with `no-welcome` after `welcomeTimeout` (10 seconds by default), instead of connecting forever.
  - A server message the client can't read fails the room with `bad-server-message` (a server on another version of the protocol), instead of being dropped.
  - A data channel that can't be made no longer leaks its `RTCPeerConnection`: each part of a link has its own release in the link's scope.
  - A connection that fails after its link opened now ends the link (`link.closed`). Before the start, a host then drops that guest, and a guest's room fails.
  - `TextChannel.onClose` on a channel that has already closed calls its handler at once, once.

  Breaking:

  - `hostRoom` and `joinRoom` return `Effect<SignallingRoom, RoomError, Scope | PeerConnector | Socket.WebSocketConstructor>` (were plain functions returning a room at once). They take `RoomOptions` (`url`, `openTimeout`, `welcomeTimeout`), which replaces `SignallingOptions`: `rtc`, `connectPeer` and `openSocket` are gone. Provide `browserRoomLayer(rtc)` instead, or fakes of its two services.
  - `SignallingRoom` lost `status`, `subscribe` and `close`. It gained `events: Stream<RoomEvent, RoomError>`, and `start` is now `Effect<void>` (was `() => void`). `code` and `self` are `string` (were `string | undefined`). Close the room's scope to leave.
  - `RoomEvent` lost `welcome` (the acquire succeeds instead) and `failed` (the room fails with a `RoomError` instead). `RoomStatus`, `SignallingSocket` and `SignallingSocketHandlers` are removed.
  - `RoomFailure` gained `no-welcome` and `bad-server-message`. Failures are `RoomError` (with `reason`, `message` and the socket's `cause`), exported with the new `PeerLinkError`.
  - The `ConnectPeer` seam (`ConnectPeer`, `ConnectPeerOptions`, `PeerConnecting`) became the `PeerConnector` service, whose `connect(options)` is `Effect<PeerLink, PeerLinkError, Scope>` and reads the peer's signals from a `Queue`. The socket seam became `Socket.WebSocketConstructor`.
  - `PeerLink.close` is removed: the scope `connect` ran in owns the link. `PeerLink.closed` is new, an `Effect<void>` that succeeds once the link has closed: a channel closed, the connection failed, or the scope closed.
  - `RtcOptions.timeoutMs` became `openTimeout` (a `Duration.Input`, still 20 seconds by default). `RtcOptions.makeConnection` is new, for tests.
  - `TextChannel.onClose` now fires on a channel that has already closed, at once, inside the `onClose` call.

  Nothing else changes: `linksTransport`, the signalling protocol and the lockstep session are as they were.

- [#53](https://github.com/lucasthevenet/arcadekit/pull/53) [`f1942ba`](https://github.com/lucasthevenet/arcadekit/commit/f1942ba33d3c3bd91cb531c9d8686d7f88f0a66f) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Lockstep sessions have an Effect shell. `hostLockstepScoped(options)` and `joinLockstepScoped(options)` take the same options as `hostLockstep` and `joinLockstep` and return `Effect<ScopedLockstepSession, never, Scope>`: closing the scope stops the session listening to its transport, and the session's time is Effect's `Clock` (its monotonic time, so a `TestClock` drives it in tests). `session.run(ticker?)` ticks it until it stops, then fails with its `LockstepError`, instead of the caller polling `session.error` after each tick; interrupting it stops the ticking. After a desync it fails a second after the stop, its ticks resending the desync until then (the transport may lose it), so every peer stops with the same desync. A run left going after its scope closes dies on its next tick. Without a ticker it ticks every 4 ms of the Clock. A `Ticker` (exported) is `(onTick) => stop`, such as a dedicated worker's timer; each tick is a plain call, done before `onTick` returns, with no Effect run per tick, and the run ends once the `onTick` it stops in has returned. `session.listen(onEvent)` hears the run's events while its scope is open, each call with a listener of its own.

  `hostLockstep` no longer leaks its transport listener when starting throws (a simulation whose `create` throws, an input source whose `read` throws): it stops listening, then rethrows.

  Nothing breaks: the plain sessions, their options and the wire format are unchanged.

- [#51](https://github.com/lucasthevenet/arcadekit/pull/51) [`f46fda2`](https://github.com/lucasthevenet/arcadekit/commit/f46fda2ce4865cfd3c6d53b872d4e31e6d190801) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Lockstep sessions check what arrives on the wire, so a peer on other code, or a forged message, can no longer freeze a run.

  - Every lockstep message is decoded with an Effect Schema (integer steps, at most 64 inputs, steps or hashes per message, at most 16 players). A message that doesn't decode is dropped, and the rest of what arrived is still handled.
  - The host decodes each peer's input when it arrives and keeps at most 64 steps of it ahead of the last confirmed step. A peer whose input doesn't decode is removed from the run; a peer that can't decode a step from the host stops with a `badInput` error.

  Breaking:

  - `InputCodec.decode` returns `Result<Input, string>` (from `effect`'s `Result`) instead of returning the input or throwing. `jsonCodec` and `schemaCodec` follow; a custom codec must return `Result.succeed(input)` or `Result.fail(why)`.
  - `StopReason` has a new `badInput` kind (`player`, `step`, `issue`), and the `removed` kind has a `why` (`"stalled"` or `"badInput"`, exported as `RemovedWhy`). A `switch` over `reason.kind` needs the new case.
  - `hostLockstep` throws a `RangeError` for more than 16 players.
  - The wire format changed: the `removed` message carries `why`, and senders send at most 64 hashes per message. Peers on this version and an older one can't play together.

- [#54](https://github.com/lucasthevenet/arcadekit/pull/54) [`7c2b526`](https://github.com/lucasthevenet/arcadekit/commit/7c2b526ac444df4606e7afca12dc059b32c119a0) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The signalling protocol (`@arcadekit/net/signalling`) is now Effect Schemas, and its parsers bound what they read.

  - Each message is a Schema, exported under its type's name: `PeerId`, `Signal`, `ClientMessage`, `ServerMessage` and `ErrorReason` (a `Schema.Literals`, so `ErrorReason.literals` lists every reason), plus a new `JoinCode`. The types are the Schemas' types, with the same shapes and the same wire format as before. `parseClientMessage` and `parseServerMessage` still return the message or `undefined`.
  - New `MAX_PEER_ID_LENGTH` (32) and `MAX_TOKEN_LENGTH` (256) are the bounds of a peer id and of an `sdpMid` or ICE username fragment, beside `MAX_MESSAGE_LENGTH` (16 KB) and `MAX_PLAYERS`.
  - `normalizeJoinCode` checks a code with `JoinCode`.

  Breaking:

  - `@arcadekit/net/signalling` now imports `effect` at runtime (it was dependency-free). `effect` is already the package's peer dependency. Its Schemas are built when it loads, so importing anything from it, even a constant or a join-code helper, bundles Effect Schema: about 77 KB minified and 25 KB gzipped (a bundler that inlines constants may still leave it out for a numeric one such as `MAX_PLAYERS`).
  - The parsers refuse messages they used to accept: a peer id over `MAX_PEER_ID_LENGTH` characters, an `sdpMid` or ICE username fragment over `MAX_TOKEN_LENGTH`, an SDP or candidate line over `MAX_MESSAGE_LENGTH`, an `sdpMLineIndex` outside 0 to 65535, and a `welcome` whose `code` isn't a join code or that lists more than `MAX_PLAYERS - 1` peers. A signalling server must send messages within these bounds: `hostRoom` and `joinRoom` ignore a server message they can't decode, so a `welcome` outside them leaves the room `connecting` with no error.

### Patch Changes

- [#51](https://github.com/lucasthevenet/arcadekit/pull/51) [`f46fda2`](https://github.com/lucasthevenet/arcadekit/commit/f46fda2ce4865cfd3c6d53b872d4e31e6d190801) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The host no longer ends a lockstep run on a peer's word. Before, any peer could stop the run for everyone by sending a desync message with any step and hashes. Now a peer's desync claim counts only as that peer's own hash for the step: the run stops only when the host's own hash for that step differs. A claim about the host's hash, or one with no hash for the sender, is ignored. The host also ignores a peer's hash for a step that isn't a hash step or that no peer can have reached yet, so those don't pile up.

## 0.1.0

### Minor Changes

- [#48](https://github.com/lucasthevenet/arcadekit/pull/48) [`36fedda`](https://github.com/lucasthevenet/arcadekit/commit/36feddaaf0af8bc3218d7b8127b0b2f6505f54aa) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - First release.
