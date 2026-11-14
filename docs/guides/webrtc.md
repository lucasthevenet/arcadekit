# Peers over WebRTC

`SignallingRoom.host` and `SignallingRoom.join` connect peers by join code through a signalling server, and `RtcTransport.fromLinks` carries the session over the WebRTC links they open. Each is a scoped Effect that succeeds once the server welcomes the peer, with its join `code` and its own id (`self`). Its scope owns the socket until the start and every peer link after it, so closing the scope is leaving, and a room that fails has already closed what it opened.

- `room.events` is a `Stream` of who joins, links and leaves. It ends with `started`. A room that fails before the start fails the stream, or the acquire, with a `SignallingRoom.RoomError` whose `reason` says why: `no-welcome` when the server doesn't answer in time, `bad-server-message` when it speaks another version of the protocol, and so on. Events wait until they are read, and leaving interrupts a reader that is still reading.
- `room.start` asks the server to start the run (host only). At the start, `RtcTransport.fromLinks(room.self, room.links())` is the session's `Transport`.
- A `PeerLink.PeerLink` has two channels: `lockstep`, unordered and unreliable, for the session, and `messages`, reliable and ordered, for what the app says around a run. Its `closed` succeeds once either channel closes, the connection fails or the link's scope closes.
- `SignallingRoom.layer(rtc)` provides what a room needs: WebRTC links (`PeerConnector`, from `RtcPeerConnector`) and the global WebSocket (`Socket.WebSocketConstructor` from `effect/socket`). Tests provide fakes of both.

```ts
import * as Game from "arcadekit/game";
import { ScopedLockstepSession } from "arcadekit/net";
import type { Ticker } from "arcadekit/net";
import { RtcTransport, SignallingRoom } from "arcadekit/net/browser";
import { Effect, Schema, Stream } from "effect";

class Sum extends Game.Simulation("Sum", {
  input: Game.PlayerInputs(Schema.Number),
  create: () => ({ total: 0 }),
  step: (state, input) => {
    for (const add of input.players) {
      state.total += add ?? 0;
    }
  },
}) {}

// Time it in a dedicated worker in a real game: a hidden tab throttles the main thread's timers.
const every4ms: Ticker.Ticker = (onTick) => {
  const timer = setInterval(onTick, 4);
  return () => clearInterval(timer);
};

const host = Effect.gen(function* () {
  // Succeeds once the signalling server welcomes this peer. The scope owns the room and its links.
  const room = yield* SignallingRoom.host({ url: "wss://game.example.com" });
  console.log(`Join code: ${room.code}`);
  // Start once a guest's link is open. The events end with `started`.
  yield* Stream.runForEach(room.events, (event) =>
    event.type === "peer-connected" ? room.start : Effect.void
  );
  const session = yield* ScopedLockstepSession.host({
    simulation: Sum,
    config: null,
    contentHash: "content-v1",
    hash: (state) => state.total,
    inputDelay: 3,
    hashEvery: 30,
    transport: RtcTransport.fromLinks(room.self, room.links()),
    local: { read: () => 1 },
    peers: room.links().map((link) => link.peer),
    seed: 7,
  });
  yield* session.run(every4ms);
}).pipe(
  Effect.catchTag("RoomError", (error) => Effect.logError(error.message)),
  Effect.catchTag("LockstepError", (error) => Effect.logError(error.message)),
  Effect.scoped,
  Effect.provide(SignallingRoom.layer())
);

Effect.runFork(host);
```
