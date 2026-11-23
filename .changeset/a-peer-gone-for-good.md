---
"arcadekit": minor
---

A peer that leaves and never comes back no longer stalls the game for ever. `Transport.connect(session, { awayFor })` waits for a peer the relay said left for `awayFor` milliseconds of the connection's ticks, 60,000 by default. Then the tick throws `Transport.Left`, with the `peers` that stayed away, and the driver stops, as it does for `Transport.Closed`.

What breaks: a game whose peer is away for more than a minute now stops with `Transport.Left` where it used to wait. Pass `{ awayFor: Infinity }` to wait for ever.
