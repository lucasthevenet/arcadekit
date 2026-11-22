---
"arcadekit": minor
---

A socket that drops no longer ends the game. `Transport.layerWebSocket(url, { reconnectFor })` connects again, waiting longer each time, for 30 seconds by default, and buffers what is sent meanwhile; it tries a taken name again while it does, since the relay may not have seen the old socket close. Every message says how far its peer has heard the others, `heard`, and a session keeps what it sent until every other peer has heard it: `session.resend()` returns it, and `session.unheard` counts it. The relay tells a room who joins it and who leaves it, with a `Message.Notice` (`{ joined }` or `{ left }`), from `Relay.joined` and `Relay.left`, which `Relay.make` sends itself. `Transport.connect` sends again what some peer hasn't heard when a peer joins, and lists the peers that left in `connected.away`, so the others know whom they wait for. `Transport.makeHub` has `disconnect(peer)` and `reconnect(peer)`, to test it.

What breaks:

- A transport's `receive` returns `Message.Message | Message.Notice`: a hand-made transport that returns only messages still is one, and code that reads `receive` tells the two apart with `"from" in arrived`.
- A host that calls `Relay.join` and `Relay.forward` itself also sends what `Relay.joined` returns once it has let a member in, and what `Relay.left` returns once its socket has closed. Without them, a peer that comes back is never sent what it missed.
- `Transport.layerWebSocket` throws `Transport.Closed` only once the socket closes for good: when it never opened, when the relay refused it, or when it could not connect again within `reconnectFor`. With `reconnectFor: 0`, it ends the game as before.
- `Transport.connect` takes a session with `resend`, which every session has.
