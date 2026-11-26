---
title: "Transports and relays"
description: "A session holds no socket. Transports carry its messages: between tabs of one browser, between machines through a relay, or over a channel of your own."
---

A **transport** is the service, `Transport`, that carries a session's messages to the other peers, since a session holds no socket. Listening on a transport gives two calls that don't wait: `send(message)` to every other peer, and `receive()`, which returns what has arrived since the last call. Each returns an Effect. Between machines, messages pass through a **relay**.

## Connect a session to a transport

`Transport.connect(session)` listens on the transport and returns what a driver steps in the session's place. Each tick, it passes the session what arrived, runs the session's tick, and sends what the session produced. It sends even when the tick waited or failed, so a session that stops because the peers drifted apart tells the others first.

There is no default transport. A multiplayer game without one doesn't compile, so every way of reaching the other peers is a choice you make.

| Transport | Connects |
| --- | --- |
| `Transport.layerBroadcastChannel(name, me)` | The tabs, windows and workers of one browser, with no server |
| `Transport.layerWebSocket(url)` | Machines, through a relay |
| `Transport.fromWire(wire)` | Anything that carries bytes and text, such as a data channel or a port |
| `Transport.makeHub(options)` | Peers in one test, in memory. See [testing several peers](testing-peers.md#connect-several-peers) |

A transport's channel must deliver every message, in any order. The session drops duplicates. It also keeps what it sent until every other peer has said it heard it, and sends it again when a relay says a peer joined the room, so a socket that drops and connects again loses nothing.

A transport's layer opens nothing. `Transport.connect` listens on the transport in a scope of its own, as an app listens to its devices. The channel or the socket opens then. It closes with the connection's `close`, which closes the session too, and `Driver.run` closes the connection when it ends. Provide the layer to the whole program or to `Transport.connect` alone. Either way, the channel lasts until the connection is closed. A transport used after that dies and says so.

`Transport.listen` listens on the transport in the scope it runs in, until that scope closes, for a program that sends and receives messages itself.

## Connect peers within one browser

Every peer that opens `Transport.layerBroadcastChannel(name, me)` with the same name hears every other: the tabs, windows and workers of one browser, or the threads of one process. It doesn't reach other machines. `me` is the peer's name, as its session has it.

- The frame loop pauses while its tab is hidden, and the other peers wait for a paused peer. To run two peers in one browser, use two windows side by side, not two tabs.
- Each peer tells the others it joined when its channel opens, and that it left when its channel closes, as a relay does. `Browser.runMain` closes the channel when the page is closed for good, and the `connected.away` of each other peer then lists it. A tab that is killed, or a worker that is terminated, says nothing.
- Nothing authenticates the sender here. A peer can send a message in [another peer's name](../concepts/several-players.md#only-a-relay-vouches-for-who-issued-an-action).

## Connect machines through a relay

```ts
import { App, Driver, Plugin } from "arcadekit";
import { Browser } from "arcadekit/browser";
import { Relay, Session, Transport } from "arcadekit/net";
import { Effect } from "effect";

const Game = Plugin.make("game/Game", {});
const peer = "ada";

const url = Relay.address("wss://relay.example.com/rooms", {
  room: "blue",
  peer,
});
// "wss://relay.example.com/rooms/blue?peer=ada"

const program = Driver.run(
  Effect.gen(function* () {
    const session = yield* Session.make(App.define({ plugins: [Game] }), {
      seed: 1,
      me: peer,
      others: ["grace"],
      delta: 1 / 60,
    });
    return yield* Transport.connect(session);
  })
).pipe(Effect.provide(Transport.layerWebSocket(url)));

Browser.runMain(program, { target: document.querySelector("canvas")! });
```

`Transport.layerWebSocket(url, options)` opens a WebSocket to a relay at an address that names the room and the peer, as `Relay.address` writes it. The socket opens when `Transport.connect` listens on the transport, and messages sent before then are buffered. The layer uses the standard `WebSocket`, which pages, workers and Node 22 all have.

| Option | Default | What it does |
| --- | --- | --- |
| `reconnectFor` | `30_000` | How long, in milliseconds, it keeps trying to connect again once a socket that was open drops. `0` never does |

The relay forwards what one peer of a room sends to the room's other peers. It runs no game and stores nothing about one. A room belongs to nobody. The first peer to connect opens it, and it closes when the last peer leaves. The relay holds each peer to the name it connected under, and refuses a message in another peer's name. You host the relay yourself, and the host decides who may connect under a name, as [hosting a relay](hosting-a-relay.md#check-who-connects-under-a-name) shows.

When the socket drops, the game goes on:

- The transport connects again, waiting longer each time, up to two seconds. What the session sends meanwhile is buffered.
- The relay tells the room the peer joined again, and tells the peer who is there. Every session then sends again what some peer hasn't heard, and the game continues where it was.
- While a peer is gone, the others wait for it. `connected.away` lists the peers the relay said left the room and that haven't joined it again. Show that list to the player.
- They wait for as long as `Transport.connect(session, { awayFor })` says, in milliseconds, 60,000 by default. Then the tick fails with `Transport.Left`, naming the peers that stayed away, and the driver stops and fails with it, so a program catches it by its tag.

The game ends for that peer when the socket closes for good: when it never opened, when the relay refused it, or when it couldn't connect again within `reconnectFor`. From then on, `send` and `receive` fail with `Transport.Closed`, so the next tick fails, and the driver stops and fails with it, so a program catches it by its tag, `"TransportClosed"`. The error carries the close code and the relay's reason, such as `"name taken"` when the peer's name is already in the room. While the transport connects again, it tries a taken name again, since the relay may not have seen the old socket close yet.

## Carry messages over a channel of your own

```ts
import { Transport } from "arcadekit/net";

declare const channel: RTCDataChannel;
channel.binaryType = "arraybuffer";

const transport = Transport.fromWire({
  send: (bytes) => channel.send(bytes),
  listen(onData) {
    const hear = ({ data }: MessageEvent<string | ArrayBuffer>) =>
      onData(typeof data === "string" ? data : new Uint8Array(data));
    channel.addEventListener("message", hear);
    return () => channel.removeEventListener("message", hear);
  },
});

export const layer = Transport.layer(transport);
```

`Transport.fromWire(wire)` makes a transport over anything else that carries bytes and text.

- Messages travel as the bytes `Message.encode` writes, and a relay's notices as the text `Message.encodeNotice` writes. The wire hands `onData` bytes as a `Uint8Array` and text as a string. What is neither a message nor a notice is dropped and counted in `transport.dropped`, since nothing that comes off a wire is trusted.
- The channel must deliver every message. A WebSocket does, and a data channel does once it is configured to.
- `transport.close()` stops listening, and `send` and `receive` die from then on. A transport passed to `Transport.layer` is listened on already, and your game closes it.
- It authenticates no sender, unless whatever is at the other end of the channel does.
- It doesn't tell the other peers that this one joined or left. Send them `Message.encodeNotice({ joined: me })` when the channel opens and `Message.encodeNotice({ left: me })` before it closes, or `connected.away` never lists a peer that is gone.

For a channel that carries neither bytes nor text, pass a `Transport.Listener` of your own to `Transport.layer`. Its `receive` returns messages, and a `Message.Notice` for each peer that joins or leaves, if it knows of one. Each of its calls returns an Effect, which fails with `Transport.Closed` once the channel is gone for good. Neither waits, so a tick stays one synchronous step. Whatever listens behind it fills a buffer in its own time, and `receive` returns the buffer.

## Read more

- [Hosting a relay](hosting-a-relay.md).
- [`Transport`](/reference/arcadekit/net/Transport) and [`Relay`](/reference/arcadekit/net/Relay) in the API reference.
