# @arcadekit/net

## 0.2.0

### Minor Changes

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
- Updated dependencies [[`f46fda2`](https://github.com/lucasthevenet/arcadekit/commit/f46fda2ce4865cfd3c6d53b872d4e31e6d190801), [`faebbf6`](https://github.com/lucasthevenet/arcadekit/commit/faebbf67e4237cce060a6727dae620400a8657f2)]:
  - @arcadekit/runtime@0.2.0
  - @arcadekit/core@0.2.0

## 0.1.0

### Minor Changes

- [#48](https://github.com/lucasthevenet/arcadekit/pull/48) [`36fedda`](https://github.com/lucasthevenet/arcadekit/commit/36feddaaf0af8bc3218d7b8127b0b2f6505f54aa) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - First release.

### Patch Changes

- Updated dependencies [[`36fedda`](https://github.com/lucasthevenet/arcadekit/commit/36feddaaf0af8bc3218d7b8127b0b2f6505f54aa)]:
  - @arcadekit/core@0.1.0
  - @arcadekit/runtime@0.1.0
