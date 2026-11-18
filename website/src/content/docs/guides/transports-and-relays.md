---
title: "Transports and relays"
description: "A session holds no socket. This guide covers the transports that carry its messages: between the tabs of one browser, between machines through a relay, and over a wire of the game's own."
---

A session holds no socket. What carries its messages is a service, `Transport`, with two plain calls: `send(message)` to every other peer, and `receive()`, which gives what has arrived since it was last asked. Between machines, the messages go through a relay.

## Joining a session to a transport

`Transport.connect(session)` gives what a driver steps in the session's place. Each tick it hands the session what arrived, runs the tick, and sends what the session has to say, whether the tick ran, waited or failed: a session that stops because the peers have come apart says so to the others first.

There is no default transport. A game of several peers that is given none doesn't compile: every way of reaching the others is a choice.

| Transport | Between |
| --- | --- |
| `Transport.layerBroadcastChannel(name)` | The tabs, windows and workers of one browser. No server |
| `Transport.layerWebSocket(url)` | Machines, through a relay |
| `Transport.text(wire)` | Anything that carries text: a data channel, a port |
| `Transport.makeHub(options)` | Peers in one test, in memory. See [testing](testing.md) |

A transport asks little of a wire: that every message arrives, in whatever order. One that arrives twice is dropped by the session.

Provide the transport's layer to the whole program, as below. Provided to `Transport.connect` alone, it would close as soon as the session was joined, and the first tick would throw and say so.

## In one browser

Every peer that opens `Transport.layerBroadcastChannel` with the same name hears every other: the tabs, the windows and the workers of one browser, or the threads of one process. It reaches no other machine.

- The frame loop rests while its tab is hidden, and a peer that rests is waited for. Two peers in one browser are two windows side by side, not two tabs of one. A game can't say yet that it has to go on in the background.
- Nothing vouches for the sender here: a peer can send a message in [another's name](../concepts/several-players.md#who-did-it).

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

`Transport.layerWebSocket` opens a WebSocket to a relay, which passes each message on to the other peers of the room. The address names the room and the peer. What is sent before the socket opens is kept and sent when it does. It uses the `WebSocket` every platform has: a page, a worker and Node 22 alike.

A socket that closes for any other reason than its layer's scope ends the game over it:

- `send` and `receive` throw `Transport.Closed` from then on, so the next tick fails and its driver stops. It carries the close code and what the relay said: `"name taken"` for a peer whose name is in the room already.
- It doesn't connect again. A message lost on the way would be lost for good, and a peer that came back would have missed messages nobody sends twice.
- The peer whose socket closed is told. The others are told nothing, and wait.

## A relay

A relay passes what one peer of a room sends on to the others. It runs no game and keeps nothing of one.

- A room is named by its address and belongs to nobody: the first peer to ask opens it, and it is gone when the last has left.
- **The relay vouches for the sender.** A peer says who it is once, when it connects, and is held to it: a message in another's name is refused and the socket closed. So the `from` a handler is told is the peer the relay let in under that name.
- Whether that peer may have that name is the relay's host to check. A relay whose host doesn't is one on which anyone is anyone.

`arcadekit/Relay` is the relay as plain functions, for whatever accepts the sockets to call, and hosting it is the game's. See [hosting a relay](hosting-a-relay.md).

## A transport of your own

`Transport.text(wire)` makes a transport of anything else that carries text:

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

- A message travels as `Lockstep.encode` writes it. A text that isn't a message is dropped and counted in `transport.dropped`: nothing that comes off a wire is trusted.
- The wire has to deliver every message. A WebSocket does; a data channel has to be told to.
- `transport.close()` stops listening. Unlike the two layers, a transport made this way says nothing when it is used after that, unless the game makes it.
- It vouches for no sender, unless what is at the other end of the wire does.

A transport that carries no text is a `Transport.Shape` of the game's own, given to `Transport.layer`. Neither of its calls waits, so that a tick stays one synchronous step: what listens behind it fills a list in its own time, and `receive` hands the list over.

## Read more

- [Hosting a relay](hosting-a-relay.md).
- [`Transport`](/reference/arcadekit/Transport) and [`Relay`](/reference/arcadekit/Relay) in the API reference.
