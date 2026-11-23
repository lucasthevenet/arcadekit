---
title: "Hosting a relay"
description: "Peers on different machines meet at a relay. Learn the functions a relay host calls, how peers are identified, and how to host a relay on Node or Cloudflare."
---

A **relay** is where peers on different machines meet. Each peer opens a WebSocket to it, at an address that names a room and the peer, and the relay forwards what one peer sends to the others in the room. [Transports and relays](transports-and-relays.md) covers the peer's side.

`arcadekit/net/Relay` is a handler, not a server. Its plain functions decide what to do with a connection and with what it sends, and whatever accepts the sockets calls them. The module imports only Effect, so it runs anywhere Effect does.

## Call the relay from a host

```ts
import * as Relay from "arcadekit/net/Relay";
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
  // The room is told who came in, and the newcomer who is there.
  for (const { to, text } of Relay.joined(joined.value, [
    ...present,
    joined.value,
  ])) {
    (to.peer === joined.value.peer ? socket : socketOf(to)).send(text);
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

// A member's socket closed, and the member is no longer in `present`.
export const onClose = (gone: Relay.Member) => {
  for (const { to, text } of Relay.left(gone, present)) {
    socketOf(to).send(text);
  }
};
```

- `Relay.join(url, present, options)` decides whether a peer may join, from the address it asked for and who is already in the room. It refuses an address without a room or a peer, a name already taken in that room, a full room, and a name that the room's `peers` doesn't list. Room and peer names are at most 64 characters.
- `Relay.forward(member, data, present, options)` decides what to forward from a member's message: one text for every other member of its room. The relay writes the forwarded message again from what it parsed, so nothing else the peer sent is passed on. It refuses anything that isn't a message, anything longer than `maxLength`, and a message that claims to be from anyone but the member that sent it.
- `Relay.joined(member, present)` and `Relay.left(member, present)` return the notices for a member that joins or leaves the room. Every other member gets `{"joined":"ada"}` or `{"left":"ada"}`, and the member who joined gets a `joined` for each member already there. With these notices, a peer that comes back after its socket dropped is sent again what it missed, and `Transport.connect` lists who left in `away`. A member can't send a notice itself, since a notice isn't a message and `forward` refuses it.
- `present` is everyone connected, as the host tracks them. The functions keep no state between calls, so a host that sleeps between messages can call them. `Relay.Member` is the schema to store a member with.

`join` and `forward` take these options:

| Option | Default | What it does |
| --- | --- | --- |
| `maxPeers` | `8` | The most peers in a room. One more is refused with `"room full"` |
| `peers` | Any name | The only names a room admits, for a game that knows its players |
| `maxLength` | `65_536` | The longest text a member may send, in characters. A longer one is refused with `"too long"` |

A refusal is a `Relay.Refused`:

- The host closes the socket with its `code` and `reason`. The reason is short, such as `"name taken"`, since a close frame carries at most 123 bytes, and `Transport.layerWebSocket` passes it to the peer whose socket closed.
- Its `message` gives more detail, with names, for logs.
- Its `status` is the matching HTTP status, for a host that rejects the request instead of upgrading it. A page learns nothing from an HTTP rejection, so a host that wants the peer to know why accepts the socket and then closes it.

## Check who connects under a name

The relay authenticates the sender. A peer declares its name once, when it connects, and is held to it. The relay refuses a message in another peer's name, and the host closes the socket. The `from` a handler receives is therefore the peer the relay admitted under that name.

Before calling `join`, decide whether to admit the peer under the name it asks for, from whatever the request carries, such as a token, a session or a list of players. The relay checks none of it. `join` admits whoever first asks for a free name, so a host that doesn't check lets anyone claim any name.

## Host a relay on Node

`Relay.make(options)` makes a relay that tracks connections itself, and tells each room who joins and leaves. `relay.connect(url, send)` returns an `Exit` of a connection, which fails when the peer may not join. Call the connection's `receive` with what the peer sent, and its `close` when the peer leaves.

[`examples/relay.ts`](../../../../../packages/arcadekit/examples/relay.ts) wraps it in a WebSocket server on Node, in about forty lines. `pnpm --filter arcadekit relay` runs it on port 8787, or on `PORT` if set. Two machines on the same network can play through it as it is.

## Host a relay that sleeps between messages

A host that sleeps between messages calls `join`, `forward`, `joined` and `left` itself, and stores the connected members somewhere durable.

[`examples/relay-cloudflare`](../../../../../packages/arcadekit/examples/relay-cloudflare) is the relay as a Worker with one Durable Object per room, declared and deployed with [Alchemy](https://alchemy.run). It is three files, and `src/room.ts` is the host.

- The room keeps nothing in memory. Cloudflare hibernates a Durable Object between messages while it keeps the object's sockets open. Each socket carries its member as an attachment, which the room reads back on every call. The four functions need nothing more.
- `pnpm --filter arcadekit relay:cloudflare` runs it locally in workerd with `alchemy dev`, with no Cloudflare account. It keeps the stack's state in `.alchemy/`, beside the example. Run `alchemy deploy` from `examples/relay-cloudflare` to deploy it to an account.
- A peer refused there is rejected with the HTTP status before a socket exists, so it learns only that it didn't connect.
- The example targets Alchemy 2.0.0-beta.87.

Behind an API Gateway on AWS, a function per event calls the same functions, and a table stores the connected members: `join` and `joined` on connect, `forward` on each message, and `left` on disconnect, with the member's row deleted.

## Test a relay

`pnpm --filter arcadekit relay:check <address>` tests a relay wherever it runs. It passes when:

- two peers play a small game through it and end on the same world;
- a second peer with a taken name is refused;
- a message in another peer's name is refused;
- a room is told that a peer joined it and left it.

Run it against the Node relay at `ws://localhost:8787`, or against the Cloudflare one under `alchemy dev` at `ws://localhost:1337/rooms`.

## Read more

- [Several players](../concepts/several-players.md) explains what peers send each other.
- [`Relay`](/reference/arcadekit/net/Relay) and [`Transport`](/reference/arcadekit/net/Transport) in the API reference.
