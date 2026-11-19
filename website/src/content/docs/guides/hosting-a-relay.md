---
title: "Hosting a relay"
description: "Peers on different machines meet at a relay. Learn the two functions a relay host calls, how peers are identified, and how to host a relay on Node or Cloudflare."
---

Peers on different machines meet at a **relay**: each opens a WebSocket to it, at an address naming a room and the peer, and the relay forwards what one peer sends to the others in the room. This guide covers the two functions a relay host calls, peer identity, and hosting a relay on Node and on Cloudflare. [Transports and relays](transports-and-relays.md) covers the peer's side.

`arcadekit/Relay` implements the relay as a handler, not a server: plain functions that decide what to do with a connection and with what it sends, for whatever accepts the sockets to call. It imports only Effect, so it runs anywhere Effect does.

## The host's API

```ts
import { Relay } from "arcadekit";
import { Cause, Exit } from "effect";

// What the host knows: who is connected, and each member's socket.
declare const present: readonly Relay.Member[];
declare const socketOf: (member: Relay.Member) => WebSocket;

// A peer asks to join, at the address it connected to.
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

- `Relay.join(url, present, options)` decides whether a peer may join, from the address it requested and who is already in the room. It refuses an address without a room or peer, a name already taken in that room, a full room (`maxPeers`, 8 by default), and a name the room doesn't allow when the room was given its `peers`. Room and peer names are at most 64 characters.
- `Relay.forward(member, data, present, options)` decides what to forward from a member's message: one text for every other member of its room. The forwarded message is re-serialized from what the relay parsed, so nothing extra rides along. It refuses anything that isn't a message, anything longer than `maxLength` (65,536 characters by default), and a message that claims to be from anyone but the member that sent it.
- `present` is everyone connected, as the host tracks them. The functions keep no state between calls, which is what a host that sleeps between messages needs. `Relay.Member` is the schema for storing a member.

A refusal is a `Relay.Refused`:

- The host closes the socket with its `code` and `reason`. The reason is short, such as `"name taken"`, since a close frame carries at most 123 bytes, and `Transport.layerWebSocket` passes it to the peer whose socket closed.
- Its `message` gives more detail, with names, for logs.
- Its `status` is the matching HTTP status, for a host that rejects the request instead of upgrading it. A page learns nothing from an HTTP rejection, so a host that wants the peer to know why accepts the socket and then closes it.

## Peer identity

**The relay authenticates the sender.** A peer declares its name once, when it connects, and is held to it: a message in another peer's name is refused and the socket closed. The `from` a handler receives is therefore the peer the relay admitted under that name.

Deciding whether to admit that peer under that name is the host's responsibility, before it calls `join`, using whatever the request carries: a token, a session, a list of players. The relay checks none of it. `join` admits whoever first asks for a free name, so a host that doesn't check lets anyone claim any name.

## An in-memory host

`Relay.make(options)` tracks connections itself. `relay.connect(url, send)` returns a connection, to `receive` what the peer sent and to `close` when it leaves.

[`examples/Relay.ts`](../../../../../packages/arcadekit/examples/Relay.ts) wraps it in a WebSocket server on Node, in about forty lines. `pnpm --filter arcadekit relay` runs it on port 8787, or on `PORT` if set: two machines on the same network can play through it as is.

## A host that sleeps

A host that sleeps between messages calls `join` and `forward` itself, and stores the connected members somewhere durable.

[`examples/relay-cloudflare`](../../../../../packages/arcadekit/examples/relay-cloudflare) implements the relay as a Worker with one Durable Object per room, declared and deployed with [Alchemy](https://alchemy.run): three files, of which `src/Room.ts` is the host.

- The room keeps nothing in memory. Cloudflare hibernates a Durable Object between messages while keeping its sockets open. Each socket carries its member as an attachment, read back on every call: that is all `join` and `forward` need.
- `pnpm --filter arcadekit relay:cloudflare` runs it locally in workerd with `alchemy dev`, with no Cloudflare account, keeping the stack's state in a folder next to it. `alchemy deploy`, run from `examples/relay-cloudflare`, deploys it to an account.
- A peer refused there is rejected with the HTTP status before a socket exists, so it only learns that it didn't connect.
- The example targets Alchemy 2.0.0-beta.87.

Behind an API Gateway on AWS, the same two functions are called from a function per event, with connected members stored in a table: `join` on connect, `forward` on each message, and the row deleted on disconnect.

## Testing a relay

`pnpm --filter arcadekit relay:check <address>` tests a relay wherever it runs. Two peers play a small game through it and must end on the same world, a second peer with a taken name must be refused, and so must a message in another peer's name. Run it against the Node relay at `ws://localhost:8787`, or the Cloudflare one under `alchemy dev` at `ws://localhost:1337/rooms`.

## Read more

- [Several players](../concepts/several-players.md) explains what peers send each other.
- [`Relay`](/reference/arcadekit/Relay) and [`Transport`](/reference/arcadekit/Transport) in the API reference.
