---
"@arcadekit/net": minor
---

The browser's signalling client is an Effect program. `hostRoom(options)` and `joinRoom(options, code)` are scoped Effects that succeed once the signalling server welcomes the peer, so the room's `code` and `self` are always known. The scope owns the socket until the start, and every peer connection and link after it: closing it is leaving, and a room that fails has already closed what it opened. `room.events` is a `Stream` of what happens after the welcome, which ends with `started` and fails with the room's `RoomError`; events wait until they are read, and leaving interrupts a reader that is still reading. `browserRoomLayer(rtc)` provides what a room needs in a browser: the new `PeerConnector` service (`rtcPeerConnector`, over WebRTC) and `Socket.WebSocketConstructor` from `effect/socket`. Tests provide fakes of both and drive the timeouts with a `TestClock`. Also new: `PeerConnectorApi`, `PeerLinkOptions`, `PeerConnectionLike`, `IceCandidateLike`, `DataChannelLike` and `RoomServices` (`PeerConnector | Socket.WebSocketConstructor`).

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
