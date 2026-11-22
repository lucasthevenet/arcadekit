---
title: "Transports and relays"
description: "A session holds no socket. Transports carry its messages: between tabs of one browser, between machines through a relay, or over a channel of your own."
---

A session holds no socket. Its messages are carried by a service, **`Transport`**, with two plain calls: `send(message)` to every other peer, and `receive()`, which returns what has arrived since the last call. Between machines, messages pass through a **relay**.

## Connecting a session to a transport

`Transport.connect(session)` opens the transport and returns what a driver steps in the session's place. Each tick, it passes the session what arrived, runs the tick, and sends what the session produced, whether the tick ran, waited or failed: a session that stops because peers drifted apart tells the others first.

There is no default transport. A multiplayer game without one doesn't compile: every way of reaching the other peers is an explicit choice.

| Transport | Connects |
| --- | --- |
| `Transport.layerBroadcastChannel(name)` | The tabs, windows and workers of one browser, with no server |
| `Transport.layerWebSocket(url)` | Machines, through a relay |
| `Transport.text(wire)` | Anything that carries text: a data channel, a port |
| `Transport.makeHub(options)` | Peers in one test, in memory. See [testing](testing.md) |

A transport needs little from its channel: every message must arrive, in any order. Duplicates are dropped by the session. A session keeps what it sent until every other peer has said it heard it, and sends it again when a relay says a peer joined the room, so a socket that drops and connects again loses nothing.

A transport's layer opens nothing. `Transport.connect` opens the channel or the socket in the scope of the program that calls it, and it closes with that scope, so `Transport.connect` requires a `Scope`. Provide the layer to the whole program or to `Transport.connect` alone: either way, the channel lasts as long as the program that drives the session. A transport used after its scope has closed throws and says so.

`Transport.open` opens the transport the same way, for a program that sends and receives messages itself.

## Within one browser

Every peer that opens `Transport.layerBroadcastChannel` with the same name hears every other: the tabs, windows and workers of one browser, or the threads of one process. It doesn't reach other machines.

- The frame loop pauses while its tab is hidden, and the other peers wait for a paused peer. To run two peers in one browser, use two windows side by side, not two tabs.
- Nothing authenticates the sender here: a peer can send a message in [another peer's name](../concepts/several-players.md#who-issued-an-action).

## Between machines

```ts
import { App, Driver, Plugin } from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Relay, Session, Transport } from "arcadekit/net";
import { Effect } from "effect";

const Game = Plugin.make("game/Game", {});
const peer = "ada";

const url = Relay.address("wss://relay.example.com/rooms", {
  room: "blue",
  peer,
});
// "wss://relay.example.com/rooms/blue?peer=ada"

const program = Effect.gen(function* () {
  const session = yield* Session.make(App.define({ plugins: [Game] }), {
    seed: 1,
    peer,
    peers: ["ada", "grace"],
    delta: 1 / 60,
  });
  return yield* Driver.frames(yield* Transport.connect(session), { hz: 60 });
}).pipe(Effect.scoped, Effect.provide(Transport.layerWebSocket(url)));

Browser.runMain(program, { target: document.querySelector("canvas")! });
```

`Transport.layerWebSocket(url, options)` opens a WebSocket to a relay, which forwards each message to the room's other peers. The address names the room and the peer. It opens when `Transport.connect` opens the transport. Messages sent before the socket opens are buffered and sent once it does. It uses the standard `WebSocket`, available in pages, workers and Node 22 alike.

| Option | Default | What it does |
| --- | --- | --- |
| `reconnectFor` | `30_000` | How long, in milliseconds, it keeps trying to connect again once a socket that was open drops. `0` never does |

When the socket drops, the game goes on:

- It connects again, waiting longer each time, up to two seconds. What the session sends meanwhile is buffered.
- The relay tells the room the peer joined again, and tells the peer who is there. Every session then sends again what some peer hasn't heard, and the game continues where it was.
- While a peer is gone, the others wait for it, and `connected.away` lists it: the peers the relay said left the room and that haven't joined it again. Show it to the player.

The game ends for that peer when the socket closes for good: when it never opened, when the relay refused it, or when it could not connect again within `reconnectFor`. `send` and `receive` throw `Transport.Closed` from then on, so the next tick fails and its driver stops. The error carries the close code and the relay's reason: `"name taken"` when the peer's name is already in the room. A taken name is tried again while the transport connects again, since the relay may not have seen the old socket close yet.

## Relays

A relay forwards what one peer of a room sends to the others. It runs no game and stores nothing about one.

- A room is identified by its address and owned by nobody: the first peer to connect opens it, and it closes when the last peer leaves.
- The relay tells the room who joins it and who leaves it. `Transport.connect` reads it: a peer that joins is sent again what it missed, and a peer that leaves is in `connected.away` until it joins again.
- **The relay authenticates the sender.** A peer declares its name once, when it connects, and is held to it: a message in another peer's name is refused and the socket closed. The `from` a handler receives is therefore the peer the relay admitted under that name.
- Deciding whether that peer may use that name is the relay host's responsibility. A relay whose host doesn't check lets anyone claim any name.

`arcadekit/net/Relay` implements the relay as plain functions, which whatever accepts the sockets calls. You host it yourself; see [hosting a relay](hosting-a-relay.md).

## Custom transports

`Transport.text(wire)` creates a transport over anything else that carries text:

```ts
import { Transport } from "arcadekit/net";

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

- Messages travel in the format `Message.encode` writes, and a relay's notices in the format `Message.encodeNotice` writes. Text that is neither is dropped and counted in `transport.dropped`: nothing that comes off a wire is trusted.
- The channel must deliver every message. A WebSocket does; a data channel must be configured to.
- `transport.close()` stops listening. `send` and `receive` throw from then on. A transport passed to `Transport.layer` is open already, and your game closes it.
- It authenticates no sender, unless whatever is at the other end of the channel does.

A transport that doesn't carry text is a `Transport.Shape` of your own, passed to `Transport.layer`. Its `receive` returns messages, and a `Message.Notice` for each peer that joins or leaves, if it knows. Neither of its calls waits, so a tick stays one synchronous step: whatever listens behind it fills a buffer in its own time, and `receive` returns the buffer.

## Read more

- [Hosting a relay](hosting-a-relay.md).
- [`Transport`](/reference/arcadekit/net/Transport) and [`Relay`](/reference/arcadekit/net/Relay) in the API reference.
