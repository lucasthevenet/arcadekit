---
"arcadekit": minor
---

`arcadekit/net` is written as Effect's modules are, and every export of `arcadekit/net`, `arcadekit/net/browser`, `arcadekit/net/testing`, `arcadekit/net/signalling` and `arcadekit/net/worker` has Effect's doc comment, with an example that runs. Each entry's public file exports namespaces, and `Coop` keeps its builder: a game declares its Coop as before. **Breaking**: every other export is renamed into a namespace, the entry's errors are `Schema.TaggedError`s, and the test helpers, the in-memory network, a transport, a peer link and a signalling room are data types with a `TypeId`.

What changed besides the names:

- **The lockstep protocol is as it was.** A tick decides each step's input and runs the steps in the call that ticks it, on the time it is given, with its resends, its stall timers and its listeners inside it. A session's `tick`, `subscribe`, `send` and `dispose` are its methods, as `Game.Loop`'s are, on a value with a `TypeId`. No recorded hash moves.
- **A scoped session's Effects are traced**, as `ScopedLockstepSession.run`, `.listen`, `.send`, and its constructors as `ScopedLockstepSession.host` and `.join`. So are a Co-op client's methods, under the declared name (`SumCoop.host`, `SumCoop.send`, `SumCoop.attach` …), a signalling room's constructors and a peer connector's `connect`. A failure's cause carries the span: compare the error (`Effect.flip`) or the cause's reasons, not a whole `Exit`.
- **A co-op host draws its run's seed from Effect's `Random`**, as an engine's run does, where it read `crypto.getRandomValues`. Every guest gets the host's seed in its start message, as before.
- **`LockstepError`, `RoomError` and `PeerLinkError` are `Schema.TaggedError`s**, with the fields they had. An app catches each by its tag, as before.
- **A transport, a peer link, a signalling room, a peer connector, the Co-op rooms and a Co-op client are made with their module's `make`**, so a test's stand-in for one is `Transport.make({ self, send, listen })`, `PeerLink.make(...)`, `SignallingRoom.make(...)`, `PeerConnector.make({ connect })`, `CoopRooms.make({ host, join })` or `CoopClient.make(...)`, not an object literal.
- **A test on fake timers provides `PageTimers.layer`** to each of its Effects, where it wrapped them in `onFakeTimers`: the same Clock and scheduler, as services.
- **The signalling protocol is a module per type** (`ClientMessage`, `ServerMessage`, `Signal`, `PeerId`, `JoinCode`, `Room`), its constants camelCase.

```ts
import {
  LockstepSession,
  MemoryNetwork,
  ScopedLockstepSession,
} from "arcadekit/net";
import {
  CoopRooms,
  RtcPeerConnector,
  RtcTransport,
  SignallingRoom,
} from "arcadekit/net/browser";
import {
  FakeCoopRooms,
  ManualTicker,
  PageTimers,
  TestGame,
} from "arcadekit/net/testing";
import { SignallingWorker } from "arcadekit/net/worker";
import { Effect, Layer } from "effect";

// Before: const network = createMemoryNetwork({ seed: 1 }); network.connect("host"); network.advance(4);
const network = MemoryNetwork.make({ seed: 1 });
const transport = MemoryNetwork.connect(network, "host");
MemoryNetwork.advance(network, 4);

// Before: hostLockstep(options, 0), joinLockstep(options, 0), hostLockstepScoped(options)
//   LockstepSession.host(options, 0), LockstepSession.join(options, 0), ScopedLockstepSession.host(options)

// Before: browserCoopRoomsLayer(() => ({ url, iceServers: DEFAULT_ICE_SERVERS }))
const rooms = CoopRooms.layer(() => ({
  url: "wss://game.example.com",
  iceServers: RtcPeerConnector.defaultIceServers,
}));

// Before: const hub = fakeCoopRooms(); hub.layer; const timer = manualTicker(); timer.layer; timer.tick();
const hub = FakeCoopRooms.make();
const timer = ManualTicker.make();
const testRooms = Layer.mergeAll(
  FakeCoopRooms.layer(hub),
  ManualTicker.layer(timer)
);
ManualTicker.tick(timer);

// Before: Effect.runPromise(onFakeTimers(effect))
const onPage = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.provide(PageTimers.layer)));

// Before: export class SignallingRoom extends signallingRoom() {}; export default signallingWorker({ ... });
export class Room extends SignallingWorker.room() {}
export default SignallingWorker.make({ rooms: "ROOMS", assets: "ASSETS" });
```

**Breaking**

Every export that changed, and what a game writes now. `Coop` and its types (`AnyCoop`, `CoopCases`, `CoopClass`, `CoopDefinition`, `CoopId`, `CoopService`, `RunCases`) keep their names and types.

| Before | Now |
| --- | --- |
| `hostLockstep(options, nowMs)`, `joinLockstep(options, nowMs)` | `LockstepSession.host(options, nowMs)`, `LockstepSession.join(options, nowMs)` |
| `LockstepSession<...>` | `LockstepSession.LockstepSession<...>`, with a `TypeId`; `LockstepSession.isLockstepSession` is new |
| `LockstepOptions`, `HostOptions`, `JoinOptions`, `LockstepStatus` | `LockstepSession.Options`, `.HostOptions`, `.JoinOptions`, `.Status` |
| `LockstepError`, a `Data.TaggedError`; `StopReason`, `RemovedWhy` | `LockstepSession.LockstepError`, a `Schema.TaggedError`; `LockstepSession.StopReason`, `.RemovedWhy` |
| `hostLockstepScoped(options)`, `joinLockstepScoped(options)` | `ScopedLockstepSession.host(options)`, `ScopedLockstepSession.join(options)` |
| `ScopedLockstepSession<...>` | `ScopedLockstepSession.ScopedLockstepSession<...>`, with a `TypeId`; `ScopedLockstepSession.isScopedLockstepSession` is new |
| `Ticker` | `Ticker.Ticker` |
| `createMemoryNetwork(options)`, `MemoryNetwork`, `MemoryNetworkOptions` | `MemoryNetwork.make(options)`, `MemoryNetwork.MemoryNetwork`, `MemoryNetwork.Options`; `MemoryNetwork.isMemoryNetwork` is new |
| `network.connect(id)`, `network.advance(nowMs)`, `network.cutOff(id, cut)` | `MemoryNetwork.connect(network, id)`, `MemoryNetwork.advance(network, nowMs)`, `MemoryNetwork.cutOff(network, id, cut)` |
| `Transport` (an interface a literal could be), `PeerId` | `Transport.Transport`, made with `Transport.make`; `Transport.PeerId`; `Transport.isTransport` is new |
| `linksTransport(self, links)` | `RtcTransport.fromLinks(self, links)` |
| `PeerLink`, `TextChannel` | `PeerLink.PeerLink`, made with `PeerLink.make`; `PeerLink.TextChannel`; `PeerLink.isPeerLink` is new |
| `PeerLinkError`, a `Data.TaggedError` | `PeerConnector.PeerLinkError`, a `Schema.TaggedError` |
| `PeerConnector` (a class), `PeerConnectorApi`, `PeerLinkOptions` | `PeerConnector.PeerConnector` (the key and the shape), made with `PeerConnector.make`; `PeerConnector.ConnectOptions`; `PeerConnector.isPeerConnector` is new |
| `rtcPeerConnector(options)`, `RtcOptions`, `DEFAULT_ICE_SERVERS`, `PeerConnectionLike`, `IceCandidateLike`, `DataChannelLike` | `RtcPeerConnector.make(options)`, `RtcPeerConnector.Options`, `.defaultIceServers`, `.PeerConnectionLike`, `.IceCandidateLike`, `.DataChannelLike`; `RtcPeerConnector.layer` is new |
| `hostRoom(options)`, `joinRoom(options, code)`, `browserRoomLayer(rtc)` | `SignallingRoom.host(options)`, `SignallingRoom.join(options, code)`, `SignallingRoom.layer(rtc)` |
| `SignallingRoom`, `RoomOptions`, `RoomEvent`, `RoomServices` | `SignallingRoom.SignallingRoom`, made with `SignallingRoom.make`; `SignallingRoom.Options`, `.Event`, `.Services`; `SignallingRoom.isSignallingRoom` is new |
| `RoomError`, a `Data.TaggedError`; `RoomFailure` | `SignallingRoom.RoomError`, a `Schema.TaggedError`; `SignallingRoom.RoomFailure` |
| `CoopRooms` (a class), `Rooms`, `browserCoopRoomsLayer(options)` | `CoopRooms.CoopRooms` (the key and the shape), made with `CoopRooms.make`; `CoopRooms.layer(options)`; `CoopRooms.isCoopRooms` is new |
| `CoopTicker` | `CoopTicker.CoopTicker` |
| `CoopClient<...>`, `CoopDebug<State>` | `CoopClient.CoopClient<...>`, with a `TypeId`, made with `CoopClient.make`; `CoopClient.Debug<State>`; `CoopClient.isCoopClient` is new |
| `LobbyChanged`, `RunStarted`, `WaitingChanged`, `SeatFailed`, `CoopEvent<Event>`, `RunEvent<Event>`, `SeatContext`, `LobbyPlayer`, `CoopFailure` | `CoopEvent.LobbyChanged`, `.RunStarted`, `.WaitingChanged`, `.SeatFailed`, `CoopEvent.CoopEvent<Event>`, `.RunEvent<Event>`, `.SeatContext`, `.LobbyPlayer`, `CoopEvent.Failure` |
| `fakeCoopRooms()`, `FakeCoopRooms`, `FAKE_JOIN_CODE` | `FakeCoopRooms.make()`, `FakeCoopRooms.FakeCoopRooms`, `FakeCoopRooms.joinCode`; `FakeCoopRooms.isFakeCoopRooms` is new |
| `hub.layer`, `hub.drop(peer)`, `hub.closeHost()` | `FakeCoopRooms.layer(hub)`, `FakeCoopRooms.drop(hub, peer)`, `FakeCoopRooms.closeHost(hub)` |
| `manualTicker()`, `timer.layer`, `timer.tick()`, `timer.ticking()` | `ManualTicker.make()`, `ManualTicker.layer(timer)`, `ManualTicker.tick(timer)`, `ManualTicker.ticking(timer)`; `ManualTicker.isManualTicker` is new |
| `onFakeTimers(effect)` | `effect.pipe(Effect.provide(PageTimers.layer))` |
| `TestGame`, `Score`, `OfferOpened`, `RunEnded`, `NothingOwed`, `AnswerOffer`, `HoldPause` | `TestGame.TestGame`, `TestGame.Score`, `.OfferOpened`, `.RunEnded`, `.NothingOwed`, `.AnswerOffer`, `.HoldPause` |
| `TestContent`, `TestConfig`, `TestInput`, `TestState`, `TestEvent`, `TestCommand`, `TestRefusals` | `TestGame.Content`, `.Config`, `.Input`, `.State`, `.Event`, `.Command`, `.Refusals` |
| `testContent`, `hashTestState` | `TestGame.content`, `TestGame.hash` |
| `PeerId`, `MAX_PEER_ID_LENGTH`, `HOST_ID` (`arcadekit/net/signalling`) | `PeerId.PeerId`, `PeerId.maxLength`, `PeerId.host` |
| `JoinCode`, `JOIN_CODE_ALPHABET`, `JOIN_CODE_LENGTH`, `joinCodeFromBytes`, `normalizeJoinCode`, `joinCodeFromPath` | `JoinCode.JoinCode`, `JoinCode.alphabet`, `JoinCode.length`, `JoinCode.fromBytes`, `JoinCode.fromTyped`, `JoinCode.fromPath` |
| `Signal`, `MAX_TOKEN_LENGTH` | `Signal.Signal`, `Signal.maxTokenLength` |
| `ClientMessage`, `MAX_MESSAGE_LENGTH`, `parseClientMessage` | `ClientMessage.ClientMessage`, `ClientMessage.maxLength`, `ClientMessage.fromJson` |
| `ServerMessage`, `ErrorReason`, `parseServerMessage` | `ServerMessage.ServerMessage`, `ServerMessage.ErrorReason`, `ServerMessage.fromJson` |
| `DEFAULT_ROOM_SIZE`, `MAX_ROOM_SIZE`, `ROOM_TTL_MS` | `Room.defaultSize`, `Room.maxSize`, `Room.ttlMs` |
| `signallingRoom(options)`, `SignallingRoomOptions`, `SignallingRoomClass` (`arcadekit/net/worker`) | `SignallingWorker.room(options)`, `SignallingWorker.RoomOptions`, `SignallingWorker.RoomClass` |
| `signallingWorker(options)`, `SignallingWorkerOptions`, `SignallingWorkerEnv`, `SignallingWorker` | `SignallingWorker.make(options)`, `SignallingWorker.Options`, `SignallingWorker.Env`, `SignallingWorker.Handler` |

The changelog keeps the old names: read it through this table.
