---
title: "Hosting a relay"
description: "Peers on different machines meet at a relay. This guide covers the two functions a relay's host calls, who a peer is, and hosting one under Node and on Cloudflare."
---

Peers on different machines meet at a relay: each opens a WebSocket to it, at an address that names a room and the peer, and what one sends the relay passes on to the others in the room. This guide covers the two functions a relay's host calls, who a peer is, and hosting one under Node and on Cloudflare. [Transports and relays](transports-and-relays.md) covers the peer's end.

`arcadekit/Relay` is the relay as a handler, and no server: plain functions that say what to do with a connection and with what it sent, for whatever accepts the sockets to call. It imports Effect alone, so it runs wherever that does.

## What a host calls

```ts
import { Relay } from "arcadekit";
import { Cause, Exit } from "effect";

// What the host knows: who is connected, and the socket of each.
declare const present: readonly Relay.Member[];
declare const socketOf: (member: Relay.Member) => WebSocket;

// A peer asks to come in, at the address it connected to.
export const onConnect = (url: string, socket: WebSocket) => {
  const joined = Relay.join(url, present); // Exit<Member, Refused>
  if (Exit.isFailure(joined)) {
    const refused = Cause.squash(joined.cause) as Relay.Refused;
    socket.close(refused.code, refused.reason);
    return undefined;
  }
  return joined.value; // { room, peer }, to keep with the connection
};

// A member sent something.
export const onMessage = (from: Relay.Member, data: string) => {
  const deliveries = Relay.forward(from, data, present); // Exit<Delivery[], Refused>
  if (Exit.isFailure(deliveries)) {
    const refused = Cause.squash(deliveries.cause) as Relay.Refused;
    socketOf(from).close(refused.code, refused.reason);
    return;
  }
  for (const { to, text } of deliveries.value) {
    socketOf(to).send(text);
  }
};
```

- `Relay.join(url, present, options)` says whether a peer may come in, from the address it asked for and who is in the room already. It refuses an address that names no room or no peer, a name that is taken in that room, a full room (`maxPeers`, 8 unless told), and a name the room doesn't let in when it was given its `peers`. A room's or a peer's name is 64 characters at most.
- `Relay.forward(member, data, present, options)` says what to pass on of what a member sent: one text for every other member of its room. What is passed on is the message as the relay read it, written out again, so nothing rides along. It refuses what isn't a message, what is longer than `maxLength` (65,536 characters unless told), and a message that says it is from anyone but the member that sent it.
- `present` is whoever is connected, as the host knows them. The functions keep nothing between two calls, which is what a host that is put to sleep between two messages needs. `Relay.Member` is the schema to keep a member with.

A refusal is a `Relay.Refused`:

- A host closes the socket with its `code` and `reason`. The reason is a few words, `"name taken"`, since a close frame carries 123 bytes at most, and `Transport.layerWebSocket` hands it to the peer it was closed on.
- Its `message` says more, with the names, for a log.
- Its `status` is the HTTP status, for a host that turns the request away instead. A page is told nothing of that, so a host that wants the peer to know why accepts the socket and closes it.

## Who a peer is

**The relay vouches for the sender.** A peer says who it is once, when it connects, and is held to it: a message in another's name is refused and the socket closed. So the `from` a handler is told is the peer the relay let in under that name.

Whether to let that peer in under that name is the host's to decide before it calls `join`, with whatever the request carries: a token, a session, a list of players. The relay asks nothing of it. `join` lets in whoever asks first under a free name, so a host that doesn't check has a relay on which anyone is anyone.

## A host that stays in memory

`Relay.make(options)` keeps who is connected itself. `relay.connect(url, send)` gives a connection, to `receive` what the peer sent and to `close` when it has gone.

[`examples/relay.ts`](../../../../../packages/arcadekit/examples/relay.ts) is that behind a WebSocket server under Node, about forty lines. `pnpm --filter arcadekit relay` runs it, on port 8787 unless `PORT` says otherwise: two machines on one network play through it as it is.

## A host that sleeps

A host that is put to sleep between messages calls `join` and `forward` itself, and keeps who is connected where it lasts.

[`examples/relay-cloudflare`](../../../../../packages/arcadekit/examples/relay-cloudflare) is the relay as a Worker and a Durable Object per room, declared and deployed with [Alchemy](https://alchemy.run): three files, of which `src/room.ts` is the host.

- The room keeps nothing in memory. Cloudflare puts a Durable Object to sleep between two messages and keeps its sockets open. Each socket carries its member as an attachment, which is read back on every call: that is all `join` and `forward` ask to be told.
- `pnpm --filter arcadekit relay:cloudflare` runs it on this machine, in workerd, with no Cloudflare account: `alchemy dev`, with the stack's state kept in a folder beside it. `alchemy deploy`, from `examples/relay-cloudflare`, puts it on an account.
- A peer that is refused there is turned away with the HTTP status, before there is a socket, and so learns only that it didn't connect.
- Alchemy is a beta. The example is written against 2.0.0-beta.87.

Behind an API gateway on AWS the same two functions are called from a function per event, with who is connected kept in a table: `join` on connect, `forward` on a message, and the row deleted on disconnect.

## Checking a relay

`pnpm --filter arcadekit relay:check <address>` checks a relay wherever it runs. Two peers of a small game play through it and have to end on the same world, a second peer of a taken name has to be refused, and so does a message in another's name.

It passes against the Node relay, `ws://localhost:8787`, and against the Cloudflare one under `alchemy dev`, `ws://localhost:1337/rooms`. It hasn't been run against a deployed Worker, which needs an account.

## Not done yet

- Neither example is a package to install: a game copies the one it needs. There is none for AWS, and the Cloudflare one was never deployed from the repository.
- A relay doesn't say who has come and gone, and doesn't slow a peer that sends too much.
- A relay doesn't ask who a peer is, and nothing hands `join` proof of it.

## Read more

- [Several players](../concepts/several-players.md) explains what the peers send each other.
- [`Relay`](/reference/arcadekit/Relay) and [`Transport`](/reference/arcadekit/Transport) in the API reference.
