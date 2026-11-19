---
title: "Transports and relays"
description: "A session holds no socket. Transports carry its messages: between tabs of one browser, between machines through a relay, or over a channel of your own."
---

A session holds no socket. Its messages are carried by a service, **`Transport`**, with two plain calls: `send(message)` to every other peer, and `receive()`, which returns what has arrived since the last call. Between machines, messages pass through a **relay**.

## Connecting a session to a transport

`Transport.connect(session)` returns what a driver steps in the session's place. Each tick, it passes the session what arrived, runs the tick, and sends what the session produced, whether the tick ran, waited or failed: a session that stops because peers drifted apart tells the others first.

There is no default transport. A multiplayer game without one doesn't compile: every way of reaching the other peers is an explicit choice.

| Transport | Connects |
| --- | --- |
| `Transport.layerBroadcastChannel(name)` | The tabs, windows and workers of one browser, with no server |
| `Transport.layerWebSocket(url)` | Machines, through a relay |
| `Transport.text(wire)` | Anything that carries text: a data channel, a port |
| `Transport.makeHub(options)` | Peers in one test, in memory. See [testing](testing.md) |

A transport needs little from its channel: every message must arrive, in any order. Duplicates are dropped by the session.

Provide the transport's layer to the whole program, as below. Provided to `Transport.connect` alone, it closes as soon as the session connects, and the first tick throws with an explanation.

## Within one browser

Every peer that opens `Transport.layerBroadcastChannel` with the same name hears every other: the tabs, windows and workers of one browser, or the threads of one process. It doesn't reach other machines.

- The frame loop pauses while its tab is hidden, and the other peers wait for a paused peer. To run two peers in one browser, use two windows side by side, not two tabs.
- Nothing authenticates the sender here: a peer can send a message in [another peer's name](../concepts/several-players.md#who-issued-an-action).

## Between machines

```ts
import { App, Driver, Plugin, Relay, Rollback, Transport } from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Effect } from "effect";

const Game = Plugin.make("game/Game", {});
const peer = "ada";

const url = Relay.address("wss://relay.example.com/rooms", {
  room: "blue",
  peer,
});
// "wss://relay.example.com/rooms/blue?peer=ada"

const program = Effect.gen(function* () {
  const app = yield* App.make({ plugins: [Game], seed: 1 });
  const session = Rollback.make(app, {
    peer,
    peers: ["ada", "grace"],
    delta: 1 / 60,
  });
  return yield* Driver.frames(yield* Transport.connect(session), { hz: 60 });
}).pipe(Effect.scoped, Effect.provide(Transport.layerWebSocket(url)));

Browser.runMain(program, { target: document.querySelector("canvas")! });
```

`Transport.layerWebSocket` opens a WebSocket to a relay, which forwards each message to the room's other peers. The address names the room and the peer. Messages sent before the socket opens are buffered and sent once it does. It uses the standard `WebSocket`, available in pages, workers and Node 22 alike.

When the socket closes for any reason other than its layer's scope closing, the game ends for that peer:

- `send` and `receive` throw `Transport.Closed` from then on, so the next tick fails and its driver stops. The error carries the close code and the relay's reason: `"name taken"` when the peer's name is already in the room.
- It doesn't reconnect: a message lost in transit would be lost for good, and a returning peer would have missed messages nobody resends.
- The peer whose socket closed is notified. The others aren't, and wait for it.

## Relays

A relay forwards what one peer of a room sends to the others. It runs no game and stores nothing about one.

- A room is identified by its address and owned by nobody: the first peer to connect opens it, and it closes when the last peer leaves.
- **The relay authenticates the sender.** A peer declares its name once, when it connects, and is held to it: a message in another peer's name is refused and the socket closed. The `from` a handler receives is therefore the peer the relay admitted under that name.
- Deciding whether that peer may use that name is the relay host's responsibility. A relay whose host doesn't check lets anyone claim any name.

`arcadekit/Relay` implements the relay as plain functions, which whatever accepts the sockets calls. You host it yourself; see [hosting a relay](hosting-a-relay.md).

## Custom transports

`Transport.text(wire)` creates a transport over anything else that carries text:

```ts
import { Transport } from "arcadekit";

declare const channel: RTCDataChannel;

const transport = Transport.text({
  send: (text) => channel.send(text),
  listen(onText) {
    const hear = (event: MessageEvent<string>) => onText(event.data);
    channel.addEventListener("message", hear);
    return () => channel.removeEventListener("message", hear);
  },
});

export const layer = Transport.layer(transport);
```

- Messages travel in the format `Lockstep.encode` writes. Text that isn't a message is dropped and counted in `transport.dropped`: nothing that comes off a wire is trusted.
- The channel must deliver every message. A WebSocket does; a data channel must be configured to.
- `transport.close()` stops listening. Unlike the two layers, a transport created this way doesn't report being used after that, unless your game makes it.
- It authenticates no sender, unless whatever is at the other end of the channel does.

A transport that doesn't carry text is a `Transport.Transport` of your own, passed to `Transport.layer`. Neither of its calls waits, so a tick stays one synchronous step: whatever listens behind it fills a buffer in its own time, and `receive` returns the buffer.

## Read more

- [Hosting a relay](hosting-a-relay.md).
- [`Transport`](/reference/arcadekit/Transport) and [`Relay`](/reference/arcadekit/Relay) in the API reference.
