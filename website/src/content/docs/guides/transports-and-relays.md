---
title: "Transports and relays"
description: "A session holds no socket."
---

A session holds no socket. What carries its messages is a service, `Transport`, with two plain calls: `send(message)` to every other peer, and `receive()`, which gives what has arrived since it was last asked. Between machines, the messages go through a relay.

## Joining a session to a transport

`Transport.connect(session)` gives what a driver steps in the session's place. Each tick it hands the session what arrived, runs the tick, and sends what the session has to say.

There is no default transport. A game of several peers that is given none doesn't compile.

| Transport | Between |
| --- | --- |
| `Transport.layerBroadcastChannel(name)` | The tabs, windows and workers of one browser. No server |
| `Transport.layerWebSocket(url)` | Machines, through a relay |
| `Transport.text(wire)` | Anything that carries text: a data channel, a port |
| `Transport.makeHub(options)` | Peers in one test, in memory. See [testing](testing.md) |

Provide the transport's layer to the whole program, as below. Provided to `Transport.connect` alone, it would close as soon as the session was joined.

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

The address names the room and the peer. What is sent before the socket opens is kept and sent when it does. A socket that closes for any other reason ends the game over it: the next tick fails with `Transport.Closed`, which carries the close code and what the relay said.

## A relay

A relay passes what one peer of a room sends on to the others. It runs no game and keeps nothing of one.

`arcadekit/Relay` is the relay as plain functions, for whatever accepts the sockets to call. It imports Effect alone, so it runs wherever that does:

- `Relay.join(url, present)` says whether a peer may come in, from the address it asked for and who is in the room already. It refuses a name that is taken, a full room, or an address with no room or peer.
- `Relay.forward(member, data, present)` says what to pass on of what a member sent: one text for every other member of the room. It refuses what isn't a message, what is too long, and a message in another peer's name.
- A refusal is a `Relay.Refused`, with the `code` and `reason` to close the socket with.

**The relay vouches for the sender.** A peer says who it is once, when it connects, and is held to it. So the `from` a handler is told is the peer the relay let in under that name. Whether that peer may have that name is the host's to check before it calls `join`.

## Hosting one

`Relay.make()` keeps who is connected itself, for a host that stays in memory. Under Node, behind a WebSocket server, that is about forty lines: [`examples/relay.ts`](../../../../../packages/arcadekit/examples/relay.ts), run with `pnpm --filter arcadekit relay`.

A host that is put to sleep between messages calls `join` and `forward` itself and keeps who is connected where it lasts. [`examples/relay-cloudflare`](../../../../../packages/arcadekit/examples/relay-cloudflare) is the relay as a Durable Object per room, declared with [Alchemy](https://alchemy.run): each socket carries its member as an attachment. It has been run with `alchemy dev` and not yet deployed from the repository.

`pnpm --filter arcadekit relay:check <address>` checks a relay wherever it runs: two peers play a small game through it and must end on the same world, and a taken name and a message in another's name must be refused.

## Read more

- [Carrying the messages](/reference/arcadekit#carrying-the-messages) and [a relay](/reference/arcadekit#a-relay) in the reference.
